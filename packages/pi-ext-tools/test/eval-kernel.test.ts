import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { EvalToolError } from "../src/eval/bridge.js";
import { EvalKernelHost } from "../src/eval/kernel/host.js";
import { readEvalSettings } from "../src/eval/settings.js";

function hooks(
	callTool: (name: string, args: unknown) => Promise<unknown> = async () => undefined,
) {
	const text: string[] = [];
	return {
		text,
		hooks: {
			cwd: process.cwd(),
			onText: (line: string) => text.push(line),
			onDisplay: () => undefined,
			callTool,
		},
	};
}

describe("Eval kernel host", () => {
	test("rejects JavaScript on a Node host", async () => {
		if (process.versions.bun) return;
		const host = new EvalKernelHost(process.cwd());
		try {
			await expect(host.runWithHooks("1", hooks().hooks, undefined, "javascript")).rejects.toThrow(
				"Eval language js requires a Bun host; use language py on Node.",
			);
		} finally {
			host.dispose();
		}
	});

	describe.skipIf(!process.versions.bun)("Bun JavaScript kernel", () => {
		test("runs JavaScript in a child process and keeps completed bindings", async () => {
			const host = new EvalKernelHost(process.cwd());
			const first = hooks();
			try {
				expect(
					await host.runWithHooks(
						'print("hi"); let kept = await Promise.resolve(2); kept',
						first.hooks,
					),
				).toBe(2);
				expect(first.text).toEqual(["hi\n"]);
				expect(await host.runWithHooks("kept", hooks().hooks)).toBe(2);
			} finally {
				host.dispose();
			}
		});

		test("turns nested tool failures into EvalToolError inside the kernel", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				const value = await host.runWithHooks(
					'try { await tool.read({ path: "missing" }); } catch (error) { print(error.name); }; "ok"',
					hooks(async (name, args) => {
						throw new EvalToolError({
							name: name as "read",
							args,
							text: "ENOENT",
							details: undefined,
							durationMs: 1,
							error: "ENOENT",
						});
					}).hooks,
				);
				expect(value).toBe("ok");
			} finally {
				host.dispose();
			}
		});

		test("runs Python in a child process and keeps completed bindings", async () => {
			const host = new EvalKernelHost(process.cwd());
			const first = hooks();
			try {
				expect(
					await host.runWithHooks('print("hi")\nkept = 2\nkept', first.hooks, undefined, "python"),
				).toBe(2);
				expect(first.text.join("")).toContain("hi");
				expect(await host.runWithHooks("kept", hooks().hooks, undefined, "python")).toBe(2);
			} finally {
				host.dispose();
			}
		});

		test("turns Python nested tool failures into EvalToolError", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				const value = await host.runWithHooks(
					'try:\n    tool.read({"path": "missing"})\nexcept EvalToolError as error:\n    print(type(error).__name__)\n"ok"',
					hooks(async (name, args) => {
						throw new EvalToolError({
							name: name as "read",
							args,
							text: "ENOENT",
							details: undefined,
							durationMs: 1,
							error: "ENOENT",
						});
					}).hooks,
					undefined,
					"python",
				);
				expect(value).toBe("ok");
			} finally {
				host.dispose();
			}
		});

		test("uses the configured Python interpreter", async () => {
			const pythonBin = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
				encoding: "utf8",
			}).stdout.trim();
			expect(pythonBin.length).toBeGreaterThan(0);
			const host = new EvalKernelHost(process.cwd(), { pythonBin });
			try {
				expect(
					await host.runWithHooks("import sys; sys.executable", hooks().hooks, undefined, "python"),
				).toBe(pythonBin);
			} finally {
				host.dispose();
			}
		});

		test("rejects an unusable configured Python interpreter", async () => {
			const host = new EvalKernelHost(process.cwd(), {
				pythonBin: "/tmp/pi-ext-tools-missing-python",
			});
			try {
				await expect(host.runWithHooks("1", hooks().hooks, undefined, "python")).rejects.toThrow(
					"Eval python bin is not a usable Python 3.9+ interpreter",
				);
			} finally {
				host.dispose();
			}
		});

		test("Python SIGINT abort keeps completed bindings", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(await host.runWithHooks("kept = 7\nkept", hooks().hooks, undefined, "python")).toBe(
					7,
				);
				const abort = new AbortController();
				const pending = host.runWithHooks(
					"import time\ntime.sleep(30)",
					hooks().hooks,
					abort.signal,
					"python",
				);
				await new Promise((resolve) => setTimeout(resolve, 150));
				abort.abort();
				await expect(pending).rejects.toThrow("Eval was aborted.");
				expect(await host.runWithHooks("kept", hooks().hooks, undefined, "python")).toBe(7);
			} finally {
				host.dispose();
			}
		});

		test("JavaScript cancel at await keeps completed bindings", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(await host.runWithHooks("let kept = 7; kept", hooks().hooks)).toBe(7);
				const abort = new AbortController();
				const pending = host.runWithHooks(
					"await new Promise(() => {})",
					hooks().hooks,
					abort.signal,
				);
				await new Promise((resolve) => setTimeout(resolve, 50));
				abort.abort();
				await expect(pending).rejects.toThrow("Eval was aborted.");
				expect(await host.runWithHooks("kept", hooks().hooks)).toBe(7);
			} finally {
				host.dispose();
			}
		});

		test("Python abort escalates to kill when SIGINT is ignored", async () => {
			const host = new EvalKernelHost(process.cwd(), { interruptMs: 200 });
			try {
				expect(await host.runWithHooks("kept = 7\nkept", hooks().hooks, undefined, "python")).toBe(
					7,
				);
				const abort = new AbortController();
				const pending = host.runWithHooks(
					"import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True:\n    pass",
					hooks().hooks,
					abort.signal,
					"python",
				);
				await new Promise((resolve) => setTimeout(resolve, 80));
				abort.abort();
				await expect(pending).rejects.toThrow("Eval was aborted.");
				await expect(host.runWithHooks("kept", hooks().hooks, undefined, "python")).rejects.toThrow(
					"kept",
				);
			} finally {
				host.dispose();
			}
		});

		test("Python keeps session cwd on sys.path", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(
					await host.runWithHooks("import sys\nsys.path[0]", hooks().hooks, undefined, "python"),
				).toBe(process.cwd());
			} finally {
				host.dispose();
			}
		});

		test("Python kernel does not inherit API keys", async () => {
			const previous = process.env.OPENAI_API_KEY;
			process.env.OPENAI_API_KEY = "secret-test-key";
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(
					await host.runWithHooks(
						"import os\nos.environ.get('OPENAI_API_KEY')",
						hooks().hooks,
						undefined,
						"python",
					),
				).toBe(null);
			} finally {
				if (previous === undefined) delete process.env.OPENAI_API_KEY;
				else process.env.OPENAI_API_KEY = previous;
				host.dispose();
			}
		});

		test("Python subprocess stdout does not break the kernel protocol", async () => {
			const captured = hooks();
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(
					await host.runWithHooks(
						'import os\nos.system("printf captured-fd1")\n1',
						captured.hooks,
						undefined,
						"python",
					),
				).toBe(1);
				expect(captured.text.join("")).toContain("captured-fd1");
			} finally {
				host.dispose();
			}
		});

		test("Python failures include a traceback", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				await expect(
					host.runWithHooks('raise ValueError("boom")', hooks().hooks, undefined, "python"),
				).rejects.toThrow(/Traceback[\s\S]*ValueError: boom/u);
			} finally {
				host.dispose();
			}
		});

		test("routes JavaScript process.stdout into the transcript", async () => {
			const captured = hooks();
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(
					await host.runWithHooks('process.stdout.write("from-stdout"); "ok"', captured.hooks),
				).toBe("ok");
				expect(captured.text.join("")).toContain("from-stdout");
			} finally {
				host.dispose();
			}
		});

		test("resets cwd at the start of each cell", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				await host.runWithHooks("process.chdir('/tmp'); process.cwd()", hooks().hooks);
				expect(await host.runWithHooks("process.cwd()", hooks().hooks)).toBe(process.cwd());
				await host.runWithHooks(
					"import os\nos.chdir('/tmp')\nos.getcwd()",
					hooks().hooks,
					undefined,
					"python",
				);
				expect(
					await host.runWithHooks("import os\nos.getcwd()", hooks().hooks, undefined, "python"),
				).toBe(process.cwd());
			} finally {
				host.dispose();
			}
		});

		test("inherits PYTHONPATH into the Python kernel", async () => {
			const directory = await mkdtemp(join(tmpdir(), "eval-pythonpath-"));
			await writeFile(join(directory, "eval_path_mod.py"), "value = 7\n");
			const previous = process.env.PYTHONPATH;
			process.env.PYTHONPATH = directory;
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(
					await host.runWithHooks(
						"import eval_path_mod\neval_path_mod.value",
						hooks().hooks,
						undefined,
						"python",
					),
				).toBe(7);
			} finally {
				if (previous === undefined) delete process.env.PYTHONPATH;
				else process.env.PYTHONPATH = previous;
				host.dispose();
			}
		});

		test("clears JavaScript timers after cooperative cancel", async () => {
			const host = new EvalKernelHost(process.cwd());
			const first = hooks();
			const abort = new AbortController();
			let markArmed: (() => void) | undefined;
			const armed = new Promise<void>((resolve) => {
				markArmed = resolve;
			});
			try {
				const running = host.runWithHooks(
					'print("armed"); await new Promise(() => { setTimeout(() => print("late"), 200); })',
					{
						...first.hooks,
						onText: (line) => {
							first.text.push(line);
							if (line === "armed\n") markArmed?.();
						},
					},
					abort.signal,
				);
				await armed;
				abort.abort();
				await expect(running).rejects.toThrow("Eval was aborted.");
				const second = hooks();
				expect(await host.runWithHooks("1", second.hooks)).toBe(1);
				await sleep(250);
				expect(second.text.join("")).not.toContain("late");
				expect(first.text.join("")).not.toContain("late");
			} finally {
				host.dispose();
			}
		});

		test("rejects cancellation while a JavaScript kernel starts", async () => {
			const host = new EvalKernelHost(process.cwd());
			const abort = new AbortController();
			try {
				const running = host.runWithHooks(
					"await new Promise(() => {})",
					hooks().hooks,
					abort.signal,
				);
				abort.abort();
				await expect(running).rejects.toThrow("Eval was aborted.");
			} finally {
				host.dispose();
			}
		});

		test("reset wipes one language kernel and leaves the other", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(await host.runWithHooks("let jsKept = 1; jsKept", hooks().hooks)).toBe(1);
				expect(
					await host.runWithHooks("py_kept = 2\npy_kept", hooks().hooks, undefined, "python"),
				).toBe(2);
				await expect(
					host.runWithHooks("jsKept", hooks().hooks, undefined, "javascript", true),
				).rejects.toThrow(/jsKept/u);
				expect(await host.runWithHooks("py_kept", hooks().hooks, undefined, "python")).toBe(2);
				expect(await host.runWithHooks("let jsKept = 3; jsKept", hooks().hooks)).toBe(3);
				await expect(
					host.runWithHooks("py_kept", hooks().hooks, undefined, "python", true),
				).rejects.toThrow(/py_kept/u);
				expect(await host.runWithHooks("jsKept", hooks().hooks)).toBe(3);
			} finally {
				host.dispose();
			}
		});

		test("drains large Python subprocess stdout without blocking the cell", async () => {
			const captured = hooks();
			const host = new EvalKernelHost(process.cwd());
			try {
				expect(
					await host.runWithHooks(
						"import subprocess, sys\nsubprocess.run([sys.executable, '-c', \"print('x'*100000)\"])\n1",
						captured.hooks,
						undefined,
						"python",
					),
				).toBe(1);
				expect(captured.text.join("").length).toBeGreaterThan(50_000);
			} finally {
				host.dispose();
			}
		});

		test("rejects an oversized JavaScript kernel frame", async () => {
			const host = new EvalKernelHost(process.cwd());
			try {
				await expect(
					host.runWithHooks('print("x".repeat(2_000_000)); 1', hooks().hooks),
				).rejects.toThrow(/1 MiB/u);
			} finally {
				host.dispose();
			}
		});
	});

	describe("Eval settings", () => {
		test("reads Code Mode and trims pythonBin", async () => {
			const directory = await mkdtemp(join(tmpdir(), "eval-settings-"));
			const path = join(directory, "settings.json");
			await writeFile(
				path,
				JSON.stringify({
					"pi-ext-tools": {
						eval: { enabled: true, codeMode: true, pythonBin: " /usr/bin/python3 " },
					},
				}),
			);
			expect(readEvalSettings(path)).toEqual({
				enabled: true,
				codeMode: true,
				pythonBin: "/usr/bin/python3",
			});
			await writeFile(path, JSON.stringify({ "pi-ext-tools": { eval: { pythonBin: "  " } } }));
			expect(readEvalSettings(path)).toEqual({
				enabled: false,
				codeMode: false,
				pythonBin: undefined,
			});
		});
	});
});
