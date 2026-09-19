import { afterEach, expect, test, vi } from "vitest";
import {
	createCmuxHostAdapter,
	createHerdrHostAdapter,
	type HostAdapter,
	type HostCommandResult,
	type HostCommandRunner,
	selectHostAdapter,
} from "../src/host-adapter.js";
import type { LaunchSpec } from "../src/launch-spec.js";

const spec: LaunchSpec = {
	command: "/usr/bin/node",
	argv: ["/tmp/pi cli.js", "--mode", "rpc"],
	cwd: "/tmp/work dir",
	mode: "rpc",
	stdio: "pipe",
	env: { PI_SUBAGENTS_ENDPOINT: "/tmp/socket path", PI_SUBAGENTS_TOKEN: "secret'quoted" },
	config: {} as LaunchSpec["config"],
};

const ownsAttachment = (): boolean => true;

function result(stdout = "", stderr = "", exitCode: number | null = 0): HostCommandResult {
	return { stdout, stderr, exitCode, timedOut: false };
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

afterEach(() => {
	vi.unstubAllEnvs();
});

test("Herdr attaches with the current pane, preserves env, and closes only its pane", async () => {
	vi.stubEnv("HERDR_ENV", "1");
	const { runner, calls } = runnerFor([
		result('{"id":"cli:pane:current","result":{"pane":{"pane_id":"parent"}}}'),
		result('{"id":"cli:pane:split","result":{"pane":{"pane_id":"child"}}}'),
		result(),
		result('{"pane_id":"child"}'),
		result(),
	]);
	const adapter = createHerdrHostAdapter({ runner, ownerId: "owner-1", ownsAttachment });
	const attachment = await adapter.attach(spec);
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
	]);
	expect(calls[2]?.[0]).toBe("herdr");
	expect(calls[2]?.[1]).toBe("pane");
	expect(calls[2]?.[2]).toBe("run");
	expect(calls[2]?.[3]).toBe("child");
	expect(calls[2]?.[4]).toContain("PI_SUBAGENTS_TOKEN='secret'\\''quoted'");
	expect(calls.at(-1)).toEqual(["herdr", "pane", "close", "child"]);
});

test("Herdr probe is unavailable outside a Herdr session", async () => {
	vi.stubEnv("HERDR_ENV", "0");
	const { runner } = runnerFor([]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability).toEqual({ host: "herdr", available: false, reason: "HERDR_ENV is not 1" });
});

test("cmux attaches and cleanup uses the returned surface id", async () => {
	const { runner, calls } = runnerFor([
		result('{"id":"surface:7"}'),
		result('{"panels":["surface:7"]}'),
		result(),
	]);
	const attachment = await createCmuxHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).attach(spec);
	await attachment.cleanup();
	expect(calls[0]).toEqual([
		"cmux",
		"new-split",
		"right",
		"--cwd",
		"/tmp/work dir",
		"--command",
		"PI_SUBAGENTS_ENDPOINT='/tmp/socket path' PI_SUBAGENTS_TOKEN='secret'\\''quoted' '/usr/bin/node' '/tmp/pi cli.js' '--mode' 'rpc'",
	]);
	expect(calls.at(-1)).toEqual(["cmux", "close-surface", "--surface", "surface:7"]);
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
});

test("stale cleanup refuses to close after ownership is revoked", async () => {
	vi.stubEnv("HERDR_ENV", "1");
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
	expect(calls.at(-1)?.slice(1, 3)).not.toEqual(["pane", "close"]);
});
