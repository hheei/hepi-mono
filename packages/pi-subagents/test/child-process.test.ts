import { describe, expect, test } from "vitest";
import { spawnChildRuntime } from "../src/child-process.js";

describe("child process runtime", () => {
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
		const runtime = spawnChildRuntime({
			command: process.execPath,
			args: ["-e", "process.stdin.resume()"],
			cwd: process.cwd(),
			env: process.env,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(runtime.alive).toBe(true);
		await runtime.terminate();
		expect(runtime.alive).toBe(false);
	});

	test("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
		const diagnoses: string[] = [];
		const runtime = spawnChildRuntime({
			command: process.execPath,
			args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
			cwd: process.cwd(),
			env: process.env,
			diagnose: (message) => diagnoses.push(message),
		});
		// Let the child boot: a SIGTERM that arrives before its handler is installed would kill it
		// outright and prove nothing about escalation.
		await new Promise((resolve) => setTimeout(resolve, 250));
		await runtime.terminate(50);
		expect(runtime.alive).toBe(false);
		expect(diagnoses.some((line) => line.includes("SIGKILL"))).toBe(true);
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
});
