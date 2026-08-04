import { afterEach, describe, expect, test } from "bun:test";
import { watch } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledMpatchPath } from "../src/apply-patch/mpatch-binary.js";
import { MpatchRun, runMpatch, Shell } from "../src/native-bridge.js";

const shells: Shell[] = [];
const temporaryPaths: string[] = [];

afterEach(async (): Promise<void> => {
	await Promise.all([
		...shells.splice(0).map((shell) => shell.abort()),
		...temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	]);
});

function createShell(): Shell {
	const shell = new Shell({ sessionEnv: { HEPI_NATIVE_SHELL: "ready" } });
	shells.push(shell);
	return shell;
}

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-native-mpatch-"));
	temporaryPaths.push(path);
	return path;
}

async function startMpatchAndReadProcessId<T>(
	root: string,
	start: () => Promise<T>,
): Promise<{ readonly processId: number; readonly running: Promise<T> }> {
	let resolveProcessId: (processId: number) => void;
	const published = new Promise<number>((resolve) => {
		resolveProcessId = resolve;
	});
	const watcher = watch(root, (_event, filename) => {
		if (filename !== "pid") return;
		void readFile(join(root, "pid"), "utf8").then((value) => {
			const processId = Number.parseInt(value, 10);
			if (Number.isSafeInteger(processId) && processId > 0) resolveProcessId(processId);
		});
	});
	const running = start();
	try {
		const processId = await Promise.race([
			published,
			running.then(
				() => Promise.reject(new Error("mpatch helper exited before publishing its PID")),
				(error: unknown) => Promise.reject(error),
			),
		]);
		return { processId, running };
	} finally {
		watcher.close();
	}
}

function processExists(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch {
		return false;
	}
}

describe("native Brush shell", () => {
	test("runs vendored uutils builtins with streamed output", async (): Promise<void> => {
		const shell = createShell();
		const environment = await shell.run({ command: 'test "$HEPI_NATIVE_SHELL" = ready' });
		expect(environment).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });

		const chunks: string[] = [];
		const result = await shell.run({ command: "printf '%s\\n' c b a b | sort | uniq" }, (chunk) =>
			chunks.push(chunk),
		);
		expect(result).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });
		expect(chunks.join("")).toBe("a\nb\nc\n");
		expect(await shell.liveBackgroundJobCount()).toBe(0);
	});

	test("maps JavaScript abort signals to shell cancellation", async (): Promise<void> => {
		const shell = createShell();
		const controller = new AbortController();
		const running = shell.run({ command: "while :; do :; done", signal: controller.signal });
		controller.abort();
		await expect(running).resolves.toMatchObject({ cancelled: true, timedOut: false });
	});

	test("reports shell timeouts", async (): Promise<void> => {
		const shell = createShell();
		await expect(
			shell.run({ command: "while :; do :; done", timeoutMs: 25 }),
		).resolves.toMatchObject({
			cancelled: false,
			timedOut: true,
		});
	});
});

describe("native mpatch", () => {
	test("applies package-owned mpatch through N-API", async (): Promise<void> => {
		const root = await temporaryDirectory();
		const target = join(root, "value.txt");
		await writeFile(target, "before\n", "utf8");

		const run = new MpatchRun({
			executablePath: getBundledMpatchPath(),
			cwd: root,
			unifiedDiff: "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n",
			fuzzFactor: 0,
			dryRun: false,
		});
		const result = await run.run();

		expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
		expect(await readFile(target, "utf8")).toBe("after\n");
		expect(() => run.run()).toThrow("mpatch run has already completed");
	});

	test.skipIf(process.platform === "win32")(
		"aborts and reaps a running mpatch process",
		async (): Promise<void> => {
			const root = await temporaryDirectory();
			const executablePath = join(root, "mpatch-hang");
			const pidPath = join(root, "pid");
			await writeFile(
				executablePath,
				`#!/bin/sh\nprintf '%s\\n' "$$" > "${pidPath}"\nwhile :; do :; done\n`,
				"utf8",
			);
			await chmod(executablePath, 0o755);
			const controller = new AbortController();
			let callerObservedAbort = false;
			controller.signal.onabort = (): void => {
				callerObservedAbort = true;
			};
			const { processId, running } = await startMpatchAndReadProcessId(root, () =>
				runMpatch({
					executablePath,
					cwd: root,
					unifiedDiff: "",
					fuzzFactor: 0,
					dryRun: false,
					signal: controller.signal,
				}),
			);
			controller.abort(new Error("cancelled"));
			await expect(running).rejects.toThrow("cancelled");
			expect(callerObservedAbort).toBe(true);
			expect(processExists(processId)).toBe(false);
		},
	);

	test.skipIf(process.platform === "win32")(
		"rejects output above one MiB and reaps the process",
		async (): Promise<void> => {
			const root = await temporaryDirectory();
			const executablePath = join(root, "mpatch-output");
			const pidPath = join(root, "pid");
			await writeFile(
				executablePath,
				`#!/bin/sh\nprintf '%s\\n' "$$" > "${pidPath}"\nwhile :; do printf xxxxxxxxxxxxxxxx; done\n`,
				"utf8",
			);
			await chmod(executablePath, 0o755);

			const { processId, running } = await startMpatchAndReadProcessId(root, () =>
				runMpatch({
					executablePath,
					cwd: root,
					unifiedDiff: "",
					fuzzFactor: 0,
					dryRun: false,
				}),
			);
			await expect(running).rejects.toThrow("mpatch output exceeded 1 MiB");
			expect(processExists(processId)).toBe(false);
		},
	);
});
