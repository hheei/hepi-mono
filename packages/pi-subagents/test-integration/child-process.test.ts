import { mkdirSync, watch } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { spawnChildRuntime } from "../src/child-process.js";
import { withTempDir } from "../test/helpers/tmp-dir.js";

/**
 * These cases assert what only a real process can show: an exit code, a stdin leash, and SIGKILL
 * escalation. The child states its own readiness through a marker file, so nothing here guesses how
 * long a process takes to boot. The timeout is a failure guard, not a wait.
 */

function readyMarker(filePath: string): Promise<void> {
	mkdirSync(dirname(filePath), { recursive: true });
	const watcher = watch(dirname(filePath));
	return new Promise<void>((resolve, reject) => {
		const guard = setTimeout(() => {
			watcher.close();
			reject(new Error(`the child never wrote ${filePath}`));
		}, 30_000);
		guard.unref?.();
		watcher.on("change", (_event, name) => {
			if (name !== filePath.slice(dirname(filePath).length + 1)) return;
			clearTimeout(guard);
			watcher.close();
			resolve();
		});
	});
}

test("reports the exit code and stops being alive once the process ends", async () => {
	const runtime = spawnChildRuntime({
		command: process.execPath,
		args: ["-e", "process.exit(3)"],
		cwd: process.cwd(),
		env: process.env,
	});
	expect(runtime.pid).toBeGreaterThan(0);
	await expect(runtime.exited).resolves.toBe(3);
	expect(runtime.alive).toBe(false);
});

test("keeps a child alive on an open stdin pipe, exactly like a headless Pi", async () => {
	await withTempDir("pi-subagents-child-", async (directory) => {
		const ready = readyMarker(`${directory}/ready`);
		const runtime = spawnChildRuntime({
			command: process.execPath,
			args: [
				"-e",
				`process.stdin.resume(); require("node:fs").writeFileSync(${JSON.stringify(`${directory}/ready`)}, "");`,
			],
			cwd: process.cwd(),
			env: process.env,
		});
		try {
			await ready;
			// The child is past its own startup and still held by the pipe it never writes to.
			expect(runtime.alive).toBe(true);
		} finally {
			await runtime.terminate();
		}
		expect(runtime.alive).toBe(false);
	});
});

test("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
	await withTempDir("pi-subagents-child-", async (directory) => {
		const diagnoses: string[] = [];
		const ready = readyMarker(`${directory}/armed`);
		const runtime = spawnChildRuntime({
			command: process.execPath,
			args: [
				"-e",
				`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(
					`${directory}/armed`,
				)}, ""); setInterval(() => {}, 1000);`,
			],
			cwd: process.cwd(),
			env: process.env,
			diagnose: (message) => diagnoses.push(message),
		});
		// A SIGTERM that arrived before the handler was installed would kill the child outright and
		// prove nothing about escalation, so the child's marker is what says it is armed.
		await ready;
		await runtime.terminate(50);
		expect(runtime.alive).toBe(false);
		expect(diagnoses.some((line) => line.includes("SIGKILL"))).toBe(true);
	});
});

test("refuses to report a command that never started", () => {
	expect(() =>
		spawnChildRuntime({
			command: "/definitely/not/a/binary",
			args: [],
			cwd: process.cwd(),
			env: process.env,
		}),
	).toThrow(/did not start/);
});
