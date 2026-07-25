import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "../src/tui-replay.js";
import { runReplaySessionCli } from "../src/tui-replay-session.js";

const SESSION_CLI = fileURLToPath(new URL("../src/tui-replay-session.ts", import.meta.url));

async function runProcess(
	cwd: string,
	stateDir: string,
	args: readonly string[],
	timeoutMs = 5_000,
) {
	const subprocess = Bun.spawn([process.execPath, SESSION_CLI, ...args], {
		cwd,
		env: { ...process.env, PI_TUI_REPLAY_STATE_DIR: stateDir },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		subprocess.kill();
	}, timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	clearTimeout(timeout);
	return { stdout, stderr, exitCode, timedOut };
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-debug-session-"));
	const cwd = join(root, "work");
	const stateDir = join(root, "state");
	await mkdir(cwd, { recursive: true });
	const output: string[] = [];
	const run = async (...args: string[]) => {
		output.length = 0;
		await runReplaySessionCli(args, {
			cwd,
			stateDir,
			write: (text) => output.push(stripAnsi(text)),
		});
		return [...output];
	};
	return { root, cwd, stateDir, run };
}

describe("replay session CLI", () => {
	test("persists actions across separate command calls and saves numbered artifacts", async () => {
		const context = await fixture();
		try {
			expect(await context.run("send", "hello")).toEqual(["Replay session\n> hello"]);
			expect(await context.run("key", "enter")).toEqual(["Replay session\nUser: hello\n> "]);
			expect(await context.run("send", "next")).toEqual(["Replay session\nUser: hello\n> next"]);
			expect(await context.run("show")).toEqual(["Replay session\nUser: hello\n> next"]);

			const status = await context.run("status");
			expect(JSON.parse(status[0] ?? "{}")).toMatchObject({ actions: 3, session: "default" });
			expect((await stat(context.stateDir)).mode & 0o777).toBe(0o700);
			const first = await context.run("save", "shots");
			const second = await context.run("save", "shots");
			expect(first[0]?.endsWith("shots/replay-0001")).toBe(true);
			expect(second[0]?.endsWith("shots/replay-0002")).toBe(true);
			expect(await readFile(join(context.cwd, "shots", "replay-0001", "final.txt"), "utf8")).toBe(
				"Replay session\nUser: hello\n> next\n",
			);

			await context.run("reset");
			expect(await readdir(context.stateDir)).toHaveLength(1);
			expect(JSON.parse((await context.run("status"))[0] ?? "{}")).toMatchObject({
				active: false,
				actions: 0,
			});
			expect(await context.run("show")).toEqual(["Replay session\n> "]);
		} finally {
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("replays a trusted module and wait action on every invocation", async () => {
		const context = await fixture();
		const modulePath = join(context.cwd, "scenario.ts");
		await writeFile(
			modulePath,
			`export default function scenario(host) {
  let selected = 0;
  let ready = false;
  setTimeout(() => { ready = true; host.requestRender(); }, 5);
  return {
    render: () => [\`selected: \${selected}\`, \`ready: \${ready}\`],
    handleInput(data) {
      if (data === "\\x1b[B") selected++;
      host.requestRender();
    },
  };
}\n`,
			"utf8",
		);
		try {
			expect(await context.run("start", "--module", modulePath)).toEqual([
				"selected: 0\nready: false",
			]);
			expect(await context.run("key", "down")).toEqual(["selected: 1\nready: false"]);
			expect(await context.run("wait", "20")).toEqual(["selected: 1\nready: true"]);
		} finally {
			await context.run("reset");
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("serializes concurrent processes and exits despite a live component interval", async () => {
		const context = await fixture();
		try {
			const sends = await Promise.all(
				Array.from({ length: 20 }, (_, index) =>
					runProcess(context.cwd, context.stateDir, ["send", `item-${index}`], 15_000),
				),
			);
			expect(sends.every((result) => result.exitCode === 0 && !result.timedOut)).toBe(true);
			const status = await runProcess(context.cwd, context.stateDir, ["status"]);
			expect(status.exitCode).toBe(0);
			expect(JSON.parse(status.stdout)).toMatchObject({ actions: 20 });

			await context.run("reset");
			const modulePath = join(context.cwd, "interval.ts");
			await writeFile(
				modulePath,
				`export default function scenario() {
  setInterval(() => {}, 100);
  return { render: () => ["interval active"] };
}\n`,
				"utf8",
			);
			const started = await runProcess(
				context.cwd,
				context.stateDir,
				["start", "--module", modulePath],
				2_000,
			);
			expect(started).toMatchObject({ exitCode: 0, timedOut: false });
			expect(stripAnsi(started.stdout)).toBe("interval active\n");
		} finally {
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("retries against a newer snapshot without locking component execution", async () => {
		const context = await fixture();
		const marker = join(context.root, "slow-started");
		const release = join(context.root, "slow-release");
		const modulePath = join(context.cwd, "slow.ts");
		await writeFile(
			modulePath,
			`import { existsSync, writeFileSync } from "node:fs";
export default function scenario(host) {
  let draft = "";
  return {
    render: () => [\`draft: \${draft}\`],
    handleInput(data) {
      if (data === "slow" && !existsSync(${JSON.stringify(marker)})) {
        writeFileSync(${JSON.stringify(marker)}, "");
        while (!existsSync(${JSON.stringify(release)})) {}
      }
      draft += data;
      host.requestRender();
    },
  };
}\n`,
			"utf8",
		);
		try {
			await context.run("start", "--module", modulePath);
			const first = Bun.spawn([process.execPath, SESSION_CLI, "send", "slow"], {
				cwd: context.cwd,
				env: { ...process.env, PI_TUI_REPLAY_STATE_DIR: context.stateDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++)
				await Bun.sleep(10);
			expect(await Bun.file(marker).exists()).toBe(true);
			const second = await runProcess(context.cwd, context.stateDir, ["send", "fast"], 1_000);
			await writeFile(release, "", "utf8");
			const [firstStdout, firstStderr, firstExit] = await Promise.all([
				new Response(first.stdout).text(),
				new Response(first.stderr).text(),
				first.exited,
			]);
			expect(second).toMatchObject({ exitCode: 0, timedOut: false });
			expect(firstExit).toBe(0);
			expect(firstStderr).toBe("");
			expect(stripAnsi(firstStdout)).toBe("draft: fastslow\n");
			expect(JSON.parse((await context.run("status"))[0] ?? "{}")).toMatchObject({
				actions: 2,
			});
		} finally {
			await writeFile(release, "", "utf8");
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("rejects an ABA commit after reset and identical restart", async () => {
		const context = await fixture();
		const marker = join(context.root, "aba-started");
		const release = join(context.root, "aba-release");
		const modulePath = join(context.cwd, "aba.ts");
		await writeFile(
			modulePath,
			`import { existsSync, writeFileSync } from "node:fs";
export default function scenario(host) {
  let draft = "v1:";
  return {
    render: () => [draft],
    handleInput(data) {
      if (!existsSync(${JSON.stringify(marker)})) {
        writeFileSync(${JSON.stringify(marker)}, "");
        while (!existsSync(${JSON.stringify(release)})) {}
      }
      draft += data;
      host.requestRender();
    },
  };
}\n`,
			"utf8",
		);
		try {
			await context.run("start", "--module", modulePath);
			const initialStatus = JSON.parse((await context.run("status"))[0] ?? "{}");
			const first = Bun.spawn([process.execPath, SESSION_CLI, "send", "slow"], {
				cwd: context.cwd,
				env: { ...process.env, PI_TUI_REPLAY_STATE_DIR: context.stateDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++)
				await Bun.sleep(10);
			expect(await Bun.file(marker).exists()).toBe(true);
			await context.run("reset");
			await writeFile(
				modulePath,
				`export default function scenario(host) {
  let draft = "v2:";
  return {
    render: () => [draft],
    handleInput(data) { draft += data; host.requestRender(); },
  };
}\n`,
				"utf8",
			);
			const restarted = await runProcess(context.cwd, context.stateDir, [
				"start",
				"--module",
				modulePath,
			]);
			expect(restarted.exitCode).toBe(0);
			expect(stripAnsi(restarted.stdout)).toBe("v2:\n");
			const restartedStatus = JSON.parse((await context.run("status"))[0] ?? "{}");
			expect(restartedStatus.generation).not.toBe(initialStatus.generation);
			await writeFile(release, "", "utf8");
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(first.stdout).text(),
				new Response(first.stderr).text(),
				first.exited,
			]);
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("reset or restarted");
			expect(stdout).toBe("");
			expect(JSON.parse((await context.run("status"))[0] ?? "{}")).toMatchObject({
				actions: 0,
				generation: restartedStatus.generation,
			});
			const shown = await runProcess(context.cwd, context.stateDir, ["show"]);
			expect(shown.exitCode).toBe(0);
			expect(stripAnsi(shown.stdout)).toBe("v2:\n");
		} finally {
			await writeFile(release, "", "utf8");
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("reset wins against a start that observed a missing session", async () => {
		const context = await fixture();
		const marker = join(context.root, "start-observed-missing");
		const release = join(context.root, "start-release");
		const modulePath = join(context.cwd, "blocking-start.ts");
		await writeFile(
			modulePath,
			`import { existsSync, writeFileSync } from "node:fs";
export default function scenario() {
  writeFileSync(${JSON.stringify(marker)}, "");
  while (!existsSync(${JSON.stringify(release)})) {}
  return { render: () => ["started"] };
}\n`,
			"utf8",
		);
		try {
			const starting = Bun.spawn([process.execPath, SESSION_CLI, "start", "--module", modulePath], {
				cwd: context.cwd,
				env: { ...process.env, PI_TUI_REPLAY_STATE_DIR: context.stateDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++)
				await Bun.sleep(10);
			expect(await Bun.file(marker).exists()).toBe(true);
			await context.run("reset");
			await writeFile(release, "", "utf8");
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(starting.stdout).text(),
				new Response(starting.stderr).text(),
				starting.exited,
			]);
			expect(exitCode).not.toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toContain("changed while start was running");
			expect(JSON.parse((await context.run("status"))[0] ?? "{}")).toMatchObject({
				active: false,
				actions: 0,
			});
		} finally {
			await writeFile(release, "", "utf8");
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("show and save stop when reset changes their generation", async () => {
		const context = await fixture();
		const block = join(context.root, "show-block");
		const marker = join(context.root, "show-started");
		const release = join(context.root, "show-release");
		const modulePath = join(context.cwd, "blocking-show.ts");
		await writeFile(
			modulePath,
			`import { existsSync, writeFileSync } from "node:fs";
export default function scenario() {
  if (existsSync(${JSON.stringify(block)})) {
    writeFileSync(${JSON.stringify(marker)}, "");
    while (!existsSync(${JSON.stringify(release)})) {}
  }
  return { render: () => ["stale frame"] };
}\n`,
			"utf8",
		);
		try {
			await context.run("start", "--module", modulePath);
			await writeFile(block, "", "utf8");
			const showing = Bun.spawn([process.execPath, SESSION_CLI, "show"], {
				cwd: context.cwd,
				env: { ...process.env, PI_TUI_REPLAY_STATE_DIR: context.stateDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++)
				await Bun.sleep(10);
			expect(await Bun.file(marker).exists()).toBe(true);
			await context.run("reset");
			await writeFile(release, "", "utf8");
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(showing.stdout).text(),
				new Response(showing.stderr).text(),
				showing.exited,
			]);
			expect(exitCode).not.toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toContain("reset or restarted");

			await rm(block, { force: true });
			await rm(marker, { force: true });
			await rm(release, { force: true });
			await context.run("start", "--module", modulePath);
			await writeFile(block, "", "utf8");
			const saving = Bun.spawn([process.execPath, SESSION_CLI, "save"], {
				cwd: context.cwd,
				env: { ...process.env, PI_TUI_REPLAY_STATE_DIR: context.stateDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++)
				await Bun.sleep(10);
			expect(await Bun.file(marker).exists()).toBe(true);
			await context.run("reset");
			await writeFile(release, "", "utf8");
			const [saveStdout, saveStderr, saveExitCode] = await Promise.all([
				new Response(saving.stdout).text(),
				new Response(saving.stderr).text(),
				saving.exited,
			]);
			expect(saveExitCode).not.toBe(0);
			expect(saveStdout).toBe("");
			expect(saveStderr).toContain("reset or restarted");
			expect(await readdir(join(context.cwd, "outputs"))).toEqual([]);
		} finally {
			await writeFile(release, "", "utf8");
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("rejects unsafe state directories without changing their permissions", async () => {
		const context = await fixture();
		const unsafe = join(context.root, "shared-state");
		const privateTarget = join(context.root, "private-state");
		const linked = join(context.root, "linked-state");
		const mutableParent = join(context.root, "mutable-parent");
		const nestedPrivate = join(mutableParent, "state");
		const mutableGrandparent = join(context.root, "mutable-grandparent");
		const deeplyNestedPrivate = join(mutableGrandparent, "private-parent", "state");
		await mkdir(unsafe, { mode: 0o755 });
		await chmod(unsafe, 0o755);
		await mkdir(privateTarget, { mode: 0o700 });
		await symlink(privateTarget, linked);
		await mkdir(nestedPrivate, { recursive: true, mode: 0o700 });
		await chmod(mutableParent, 0o777);
		await mkdir(deeplyNestedPrivate, { recursive: true, mode: 0o700 });
		await chmod(join(mutableGrandparent, "private-parent"), 0o700);
		await chmod(mutableGrandparent, 0o777);
		const cwdMode = (await stat(context.cwd)).mode & 0o777;
		try {
			await expect(
				runReplaySessionCli(["status"], { cwd: context.cwd, stateDir: unsafe }),
			).rejects.toThrow("mode 0700");
			expect((await stat(unsafe)).mode & 0o777).toBe(0o755);
			await expect(
				runReplaySessionCli(["status"], { cwd: context.cwd, stateDir: linked }),
			).rejects.toThrow("must not be a symlink");
			await expect(
				runReplaySessionCli(["status"], { cwd: context.cwd, stateDir: nestedPrivate }),
			).rejects.toThrow("parent is writable by another user");
			await expect(
				runReplaySessionCli(["status"], {
					cwd: context.cwd,
					stateDir: deeplyNestedPrivate,
				}),
			).rejects.toThrow("parent is writable by another user");
			await expect(
				runReplaySessionCli(["status"], { cwd: context.cwd, stateDir: "" }),
			).rejects.toThrow("must not be blank");
			expect((await stat(context.cwd)).mode & 0o777).toBe(cwdMode);
		} finally {
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("rejects prototype keys, sanitizes terminal controls, and deletes graphemes", async () => {
		const context = await fixture();
		try {
			await expect(context.run("key", "toString")).rejects.toThrow("Unsupported replay key");
			const raw: string[] = [];
			await runReplaySessionCli(
				[
					"input",
					JSON.stringify("\x1b[31mred\x1b[0m\x1b[2J\x1b]0;terminal-injection\x07"),
					"--session",
					"ansi",
				],
				{ cwd: context.cwd, stateDir: context.stateDir, write: (text) => raw.push(text) },
			);
			expect(raw[0]).toContain("\x1b[31mred\x1b[0m");
			expect(raw[0]).not.toContain("\x1b]");
			expect(raw[0]).not.toContain("\x1b[2J");
			expect(raw[0]).not.toContain("\x07");
			const reflected = await runProcess(context.cwd, context.stateDir, [
				"bad\x1b]0;error-injection\x07command",
			]);
			expect(reflected.exitCode).not.toBe(0);
			expect(reflected.stderr).not.toContain("\x1b]");
			expect(reflected.stderr).not.toContain("\x07");
			const successOutput: string[] = [];
			await runReplaySessionCli(["reset", "--session", "named\x1b]0;success-injection\x07"], {
				cwd: context.cwd,
				stateDir: context.stateDir,
				write: (text) => successOutput.push(text),
			});
			expect(successOutput[0]).not.toContain("\x1b]");
			expect(successOutput[0]).not.toContain("\x07");

			await context.run("send", "😀", "--session", "emoji");
			expect(await context.run("key", "backspace", "--session", "emoji")).toEqual([
				"Replay session\n> ",
			]);
			await context.run("send", "é", "--session", "combining");
			expect(await context.run("key", "backspace", "--session", "combining")).toEqual([
				"Replay session\n> ",
			]);
		} finally {
			await rm(context.root, { recursive: true, force: true });
		}
	});

	test("supports named journals and rejects malformed commands or state", async () => {
		const context = await fixture();
		try {
			await context.run("send", "one", "--session", "alpha");
			await context.run("send", "two", "--session", "beta");
			expect(await context.run("show", "--session", "alpha")).toEqual(["Replay session\n> one"]);
			expect(await context.run("show", "--session", "beta")).toEqual(["Replay session\n> two"]);
			expect((await readdir(context.stateDir)).length).toBe(2);

			await expect(context.run("key", "invalid")).rejects.toThrow("Unsupported replay key");
			await expect(context.run("wait", "--", "-1")).rejects.toThrow("non-negative");
			await expect(context.run("show", "extra")).rejects.toThrow("does not accept");
			await expect(context.run("--unknown")).rejects.toThrow();
			await expect(context.run("show", "--session")).rejects.toThrow();
			await expect(context.run("show", "--session", "a", "--session", "b")).rejects.toThrow(
				"only once",
			);

			const [status] = await context.run("status", "--session", "alpha");
			const parsed: unknown = JSON.parse(status ?? "null");
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("statePath" in parsed) ||
				typeof parsed.statePath !== "string"
			)
				throw new Error("status did not return statePath");
			const storedState: unknown = JSON.parse(await readFile(parsed.statePath, "utf8"));
			if (typeof storedState !== "object" || storedState === null || Array.isArray(storedState))
				throw new Error("journal did not contain an object state");
			for (const type of ["toString", "constructor", "__proto__"]) {
				await writeFile(
					parsed.statePath,
					`${JSON.stringify({ ...storedState, actions: [{ type }] })}\n`,
					"utf8",
				);
				await expect(context.run("show", "--session", "alpha")).rejects.toThrow("state is invalid");
			}
			await writeFile(parsed.statePath, "{}\n", "utf8");
			await expect(context.run("show", "--session", "alpha")).rejects.toThrow("state is invalid");
		} finally {
			await rm(context.root, { recursive: true, force: true });
		}
	});
});
