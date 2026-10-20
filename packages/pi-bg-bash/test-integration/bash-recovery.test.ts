import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { BashJobRegistry } from "../src/bash-jobs.js";
import { BashExecutionLedger } from "../src/bash-ledger.js";

/**
 * Waits for the controller's shell to publish its pid.
 *
 * The directory event is the readiness signal, so the wait costs the shell's real startup time and
 * nothing more. The bounded timeout keeps a controller that never publishes from hanging the suite.
 */
async function shellPid(directory: string): Promise<number> {
	const path = join(directory, "shell.pid");
	const read = async (): Promise<number | undefined> => {
		try {
			const pid = Number((await readFile(path, "utf8")).trim());
			return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	};
	// watch() is lazy: next() must arm it before the first read.
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(15_000);
	timeout.addEventListener("abort", () => controller.abort(), { once: true });
	const watcher = watch(directory, { signal: controller.signal });
	let change = watcher.next();
	try {
		for (;;) {
			const pid = await read();
			if (pid !== undefined) return pid;
			if ((await change).done) break;
			change = watcher.next();
		}
	} catch (error) {
		if (!(error instanceof Error) || error.name !== "AbortError") throw error;
	} finally {
		controller.abort();
		await change.catch(() => {});
	}
	throw new Error("Controller did not start its shell");
}

test.skipIf(process.platform === "win32")(
	"SIGKILL releases ledger ownership; resume reports unknown without rerun or adoption",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-bash-crash-"));
		const controller = spawn(
			process.execPath,
			[
				"--no-warnings",
				"--import",
				"jiti/register",
				fileURLToPath(new URL("./fixtures/bash-controller.ts", import.meta.url)),
				directory,
			],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		let stderr = "";
		controller.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const startup = Promise.race([
			once(controller, "message", { signal: AbortSignal.timeout(15_000) }),
			once(controller, "exit").then(([code]) => {
				throw new Error(`Controller exited ${String(code)}: ${stderr}`);
			}),
		]);
		let pid: number | undefined;
		let jobs: BashJobRegistry | undefined;
		try {
			await startup;
			const observedPid = await shellPid(directory);
			pid = observedPid;
			expect(() => new BashExecutionLedger(join(directory, "bash.sqlite"))).toThrow();
			const exited = once(controller, "exit");
			controller.kill("SIGKILL");
			await exited;
			const ledger = new BashExecutionLedger(join(directory, "bash.sqlite"));
			jobs = new BashJobRegistry(undefined, {
				ledger,
				onError: (message) => {
					throw new Error(message);
				},
			});
			const reports = jobs.pendingDeliveries();
			expect(reports).toHaveLength(1);
			expect(reports[0]).toMatchObject({
				status: "unknown",
				exitCode: null,
				diagnostic: expect.stringContaining("not resumed or rerun"),
			});
			expect(ledger.load()).toHaveLength(1);
			expect(await readFile(join(directory, "effects.txt"), "utf8")).toBe("effect\n");
			// Recovery leaves old processes alone; only this test, using its observed group, cleans up.
			expect(() => process.kill(observedPid, 0)).not.toThrow();
			jobs.stop(reports[0]!.id);
			await jobs.dispose();
			expect(() => process.kill(observedPid, 0)).not.toThrow();
		} finally {
			if (controller.exitCode === null && controller.signalCode === null) {
				const exited = once(controller, "exit");
				controller.kill("SIGKILL");
				await exited;
			}
			await jobs?.dispose();
			if (pid !== undefined) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					/* Test group already exited. */
				}
			}
			await rm(directory, { recursive: true, force: true });
		}
	},
);
