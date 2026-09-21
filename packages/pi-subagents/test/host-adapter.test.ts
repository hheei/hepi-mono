import { afterEach, expect, test, vi } from "vitest";
import {
	createCmuxHostAdapter,
	createHerdrHostAdapter,
	type HostAdapter,
	type HostAttachment,
	HostCommandError,
	type HostCommandResult,
	type HostCommandRunner,
	selectHostAdapter,
} from "../src/host-adapter.js";
import type { LaunchSpec } from "../src/launch-spec.js";

const spec: LaunchSpec = {
	command: "/usr/bin/node",
	argv: ["/tmp/pi cli.js", "--thinking", "high", "--session-id", "01J7-session"],
	cwd: "/tmp/work dir",
	mode: "tui",
	stdio: "inherit",
	env: { PI_SUBAGENTS_ENDPOINT: "/tmp/socket path", PI_SUBAGENTS_TOKEN: "secret'quoted" },
	config: {} as LaunchSpec["config"],
};

const quotedLaunch = `'/usr/bin/node' '/tmp/pi cli.js' '--thinking' 'high' '--session-id' '01J7-session'`;
const ownsAttachment = (): boolean => true;

function result(
	stdout = "",
	stderr = "",
	exitCode: number | null = 0,
	timedOut = false,
): HostCommandResult {
	return { stdout, stderr, exitCode, timedOut };
}

function runnerFor(responses: readonly HostCommandResult[]): {
	runner: HostCommandRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	let index = 0;
	return {
		calls,
		runner: {
			run: vi.fn(async (command, args) => {
				calls.push([command, ...args]);
				return responses[index++] ?? result();
			}),
		},
	};
}

function runningProcessInfo(paneId: string): string {
	return JSON.stringify({
		id: "cli:pane:process_info",
		result: {
			process_info: {
				foreground_processes: [{ argv: ["/usr/bin/node"], name: "node", pid: 42 }],
				pane_id: paneId,
				shell_pid: 7,
			},
		},
	});
}

function idleProcessInfo(paneId: string): string {
	return JSON.stringify({
		id: "cli:pane:process_info",
		result: {
			process_info: {
				foreground_processes: [{ argv: ["/usr/bin/zsh"], name: "zsh", pid: 7 }],
				pane_id: paneId,
				shell_pid: 7,
			},
		},
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
});

test("Herdr attaches with structured env, quoted LaunchSpec argv, and process-info observation", async () => {
	vi.stubEnv("HERDR_ENV", "1");
	const { runner, calls } = runnerFor([
		result('{"result":{"pane":{"pane_id":"parent"}}}'),
		result('{"result":{"pane":{"pane_id":"child"}}}'),
		result(),
		result(runningProcessInfo("child")),
		result(),
	]);
	const adapter = createHerdrHostAdapter({ runner, ownerId: "owner-1", ownsAttachment });
	const attachment = await adapter.attach(spec);
	const observed = await attachment.observe();
	await attachment.cleanup();

	expect(calls[1]).toEqual([
		"herdr",
		"pane",
		"split",
		"--pane",
		"parent",
		"--direction",
		"right",
		"--cwd",
		"/tmp/work dir",
		"--no-focus",
		"--env",
		"PI_SUBAGENTS_ENDPOINT=/tmp/socket path",
		"--env",
		"PI_SUBAGENTS_TOKEN=secret'quoted",
	]);
	expect(calls[2]).toEqual(["herdr", "pane", "run", "child", quotedLaunch]);
	expect(calls[2]?.[4]).not.toContain("PI_SUBAGENTS_TOKEN");
	expect(observed).toMatchObject({
		alive: true,
		known: true,
		identity: { host: "herdr", attachmentId: "child", createdBy: "owner-1" },
	});
	expect(calls[3]).toEqual(["herdr", "pane", "process-info", "--pane", "child"]);
	expect(calls.at(-1)).toEqual(["herdr", "pane", "close", "child"]);
});

test("Herdr probe is unavailable outside a Herdr session", async () => {
	vi.stubEnv("HERDR_ENV", "0");
	const { runner, calls } = runnerFor([]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability).toEqual({ host: "herdr", available: false, reason: "HERDR_ENV is not 1" });
	expect(calls).toEqual([]);
});

test("Herdr probe requires a current pane id, not just a herdr binary", async () => {
	vi.stubEnv("HERDR_ENV", "1");
	const { runner } = runnerFor([result("not json", "missing pane", 0)]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason).toContain("no current pane id");
});

test("Herdr split failure is a pane error and does not launch a command", async () => {
	const { runner, calls } = runnerFor([
		result('{"pane_id":"parent"}'),
		result("", "split denied", 1),
	]);
	const adapter = createHerdrHostAdapter({ runner, ownerId: "owner-1", ownsAttachment });
	try {
		await adapter.attach(spec);
		throw new Error("expected attach to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(HostCommandError);
		expect(error).toMatchObject({ kind: "pane" });
	}
	expect(calls.some((call) => call[1] === "pane" && call[2] === "run")).toBe(false);
});

test("Herdr command timeout still returns the attachment and does not close the pane", async () => {
	const { runner, calls } = runnerFor([
		result('{"pane_id":"parent"}'),
		result('{"pane_id":"child"}'),
		result("", "deadline", null, true),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).attach(spec);
	expect(attachment.identity.attachmentId).toBe("child");
	expect(attachment.launch.timedOut).toBe(true);
	expect(calls.some((call) => call[2] === "close")).toBe(false);
});

test("Herdr cleanup still closes an owned pane after the child process has exited", async () => {
	const { runner, calls } = runnerFor([
		result('{"pane_id":"parent"}'),
		result('{"pane_id":"child"}'),
		result(),
		result(idleProcessInfo("child")),
		result('{"result":{"type":"ok"}}'),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).attach(spec);
	expect((await attachment.observe()).alive).toBe(false);
	const cleanup = await attachment.cleanup();
	expect(cleanup.exitCode).toBe(0);
	expect(calls.at(-1)).toEqual(["herdr", "pane", "close", "child"]);
});

test("cmux attaches through documented new-split --command without rebuilding Pi flags", async () => {
	const { runner, calls } = runnerFor([
		result('{"surface_id":"surface:7"}'),
		result('{"panels":["surface:7"]}'),
		result(),
	]);
	const attachment = await createCmuxHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).attach(spec);
	await attachment.cleanup();
	expect(calls[0]?.[0]).toBe("cmux");
	expect(calls[0]?.slice(1, 4)).toEqual(["--json", "new-split", "right"]);
	expect(calls[0]?.[4]).toBe("--command");
	expect(calls[0]?.[5]).toContain("cd '/tmp/work dir'");
	expect(calls[0]?.[5]).toContain(quotedLaunch);
	expect(calls[0]?.[5]).not.toContain("--mode");
	expect(calls.at(-1)).toEqual(["cmux", "--json", "close-surface", "--surface", "surface:7"]);
});

test("cmux probe does not claim availability from a missing binary", async () => {
	const { runner } = runnerFor([result("", "command not found: cmux", 127)]);
	const capability = await createCmuxHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability).toEqual({
		host: "cmux",
		available: false,
		reason: "cmux unavailable: command not found: cmux",
	});
});

test("cmux probe requires a successful capabilities query after ping", async () => {
	const { runner } = runnerFor([result('{"pong":true}'), result("", "no socket methods", 1)]);
	const capability = await createCmuxHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason).toBe("cmux capability query failed");
});

function fakeAdapter(kind: "herdr" | "cmux", available: boolean): HostAdapter {
	return {
		kind,
		probe: async () => ({
			host: kind,
			available,
			reason: available ? "ready" : "unavailable",
		}),
		attach: async () => {
			throw new Error("not used");
		},
	};
}

test("default selection falls back from Herdr to cmux and records the reason", async () => {
	const selection = await selectHostAdapter({
		adapters: {
			herdr: fakeAdapter("herdr", false),
			cmux: fakeAdapter("cmux", true),
		},
	});
	expect(selection.available).toBe(true);
	if (selection.available) {
		expect(selection.selectedHost).toBe("cmux");
		expect(selection.reason).toContain("herdr: unavailable");
		expect(selection.explicit).toBe(false);
		expect(selection.attempts).toHaveLength(2);
	}
});

test("explicit unavailable host fails without silent fallback", async () => {
	const selection = await selectHostAdapter({
		preferredHost: "herdr",
		adapters: {
			herdr: fakeAdapter("herdr", false),
			cmux: fakeAdapter("cmux", true),
		},
	});
	expect(selection).toMatchObject({ available: false, selectedHost: null, explicit: true });
	expect(selection.reason).toContain("explicit host unavailable");
	expect(selection.attempts).toHaveLength(1);
});

test("stale cleanup refuses to close after ownership is revoked", async () => {
	let owned = true;
	const { runner, calls } = runnerFor([
		result('{"pane_id":"parent"}'),
		result('{"pane_id":"child"}'),
		result(),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment: () => owned,
	}).attach(spec);
	owned = false;
	const cleanup = await attachment.cleanup();
	expect(cleanup.stderr).toContain("ownership was revoked");
	expect(calls.some((call) => call[1] === "pane" && call[2] === "close")).toBe(false);
});

test("timed-out observation does not close an owned pane", async () => {
	const { runner, calls } = runnerFor([
		result('{"pane_id":"parent"}'),
		result('{"pane_id":"child"}'),
		result(),
		result("", "process-info hung", null, true),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).attach(spec);
	const cleanup = await attachment.cleanup();
	expect(cleanup.stderr).toContain("timed out");
	expect(calls.some((call) => call[2] === "close")).toBe(false);
});

test("system cmux probe is a capability failure when cmux is not live", async () => {
	const capability = await createCmuxHostAdapter({
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason.length).toBeGreaterThan(0);
});

test.skipIf(process.env.HERDR_ENV !== "1")(
	"Herdr live attach launches a process from a TUI LaunchSpec and closes only that pane",
	async () => {
		const adapter = createHerdrHostAdapter({
			ownerId: "sub-07-smoke",
			ownsAttachment,
			timeoutMs: 8_000,
		});
		const capability = await adapter.probe();
		expect(capability.available).toBe(true);
		let attachment: HostAttachment | undefined;
		try {
			const launched = await adapter.attach({
				...spec,
				command: "/usr/bin/sleep",
				argv: ["20"],
				cwd: "/tmp",
				env: { PI_SUBAGENTS_SMOKE: "sub-07" },
			});
			attachment = launched;
			let observed = await launched.observe();
			for (let attempt = 0; attempt < 10 && !observed.alive; attempt++) {
				observed = await launched.observe();
			}
			expect(observed.known).toBe(true);
			expect(observed.alive).toBe(true);
			expect(observed.identity.attachmentId.length).toBeGreaterThan(0);
		} finally {
			const cleanup = await attachment?.cleanup();
			expect(cleanup?.stderr ?? "").not.toContain("ownership was revoked");
		}
	},
	15_000,
);
