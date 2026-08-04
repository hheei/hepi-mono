import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpatchRun, Shell } from "../src/native-bridge.js";

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
	test("applies vendored mpatch through N-API", async (): Promise<void> => {
		const root = await temporaryDirectory();
		const target = join(root, "value.txt");
		await writeFile(target, "before\n", "utf8");

		const run = new MpatchRun({
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

	test("observes cancellation before starting native work", async (): Promise<void> => {
		const root = await temporaryDirectory();
		const target = join(root, "value.txt");
		await writeFile(target, "before\n", "utf8");
		const run = new MpatchRun({
			cwd: root,
			unifiedDiff: "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n",
			fuzzFactor: 0,
			dryRun: false,
		});

		await run.abort();
		await expect(run.run()).rejects.toThrow("mpatch aborted");
		expect(await readFile(target, "utf8")).toBe("before\n");
	});
});
