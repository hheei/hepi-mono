import type {
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import type { OptimizerInfo } from "../src/info.js";
import { createRtkRuntime, splitRtkChain } from "../src/rtk.js";

type TestBashEvent = ToolCallEvent & { readonly input: Record<string, unknown> };
const enabled = { enabled: true, path: "" } as const;
const result = (code: number, stdout = "", stderr = "", killed = false): ExecResult => ({
	code,
	stdout,
	stderr,
	killed,
});

function harness(exec: ExtensionAPI["exec"]) {
	const info = vi.fn<OptimizerInfo>();
	return { runtime: createRtkRuntime({ exec } as Pick<ExtensionAPI, "exec">, info), info };
}

function context(signal?: AbortSignal): ExtensionContext {
	return { ...(signal === undefined ? {} : { signal }) } as ExtensionContext;
}

function bash(command: string, input: Record<string, unknown> = {}): TestBashEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-7",
		input: { command, ...input },
	};
}

test("RTK rewrites eligible foreground Bash with the configured executable and audits the decision", async () => {
	const exec = vi.fn(async () => result(3, "rtk git status"));
	const { runtime, info } = harness(exec);
	const event = bash("git status");
	info.mockImplementation(() => {
		expect(event.input.command).toBe("git status");
	});
	await runtime.rewrite(event, context(), { enabled: true, path: "/tools/my rtk" });

	expect(event.input.command).toBe("'/tools/my rtk' git status");
	expect(exec).toHaveBeenCalledWith(
		"/tools/my rtk",
		["rewrite", "git status"],
		expect.objectContaining({ timeout: 1_000, signal: expect.any(AbortSignal) }),
	);
	expect(info).toHaveBeenCalledWith(
		expect.stringContaining("RTK ·"),
		expect.objectContaining({
			toolCallId: "call-7",
			originalCommand: "git status",
			executionCommand: "'/tools/my rtk' git status",
			reason: "rtk rewrite",
		}),
	);
});

test("RTK overlays use the configured executable for inferred and explicit calls", async () => {
	const exec = vi.fn(async () => result(1));
	const { runtime, info } = harness(exec);
	const inferred = bash("bun test");
	const explicit = bash("FOO=bar rtk git status && BAR=x rtk git diff");
	const settings = { enabled: true, path: "/tools/my rtk" };
	await runtime.rewrite(inferred, context(), settings);
	info.mockClear();
	info.mockImplementation(() => {
		expect(explicit.input.command).toBe("FOO=bar rtk git status && BAR=x rtk git diff");
	});
	await runtime.rewrite(explicit, context(), settings);
	await runtime.rewrite(bash("'/tools/my rtk' test bun test"), context(), settings);
	expect(inferred.input.command).toBe("'/tools/my rtk' test bun test");
	expect(explicit.input.command).toBe(
		"FOO=bar '/tools/my rtk' git status && BAR=x '/tools/my rtk' git diff",
	);
	expect(exec).toHaveBeenCalledTimes(1);
	expect(info).toHaveBeenCalledWith(
		expect.stringContaining("RTK ·"),
		expect.objectContaining({ reason: "configured RTK path" }),
	);
});

test("RTK leaves ineligible calls and unchanged rewrites unrecorded", async () => {
	const exec = vi.fn(async () => result(0, "git status"));
	const { runtime, info } = harness(exec);
	for (const event of [
		bash("git status"),
		bash("git status", { target: "local" }),
		{ ...bash("git status"), toolName: "read" },
		bash(" "),
		bash("rtk git status"),
		bash("git status", { target: "remote" }),
		bash("git status", { pty: true }),
		bash("git status", { async: true }),
		bash("FOO=bar rtk git status"),
	])
		await runtime.rewrite(event, context(), enabled);
	await runtime.rewrite(bash("git status"), context(), { enabled: false, path: "" });
	await runtime.rewrite(bash("git status"), context(AbortSignal.abort()), enabled);
	expect(exec).toHaveBeenCalledTimes(2);
	expect(info).not.toHaveBeenCalled();
});

test("no-match stays quiet; rejected, missing, timed-out, and empty queries retain the original with info", async () => {
	for (const [response, warning] of [
		[result(0), true],
		[result(3), true],
		[result(1), false],
		[result(2, "", "denied"), true],
		[result(9, "", "failed"), true],
		[result(0, "rtk git status", "", true), true],
		[new Error("missing rtk"), true],
	] as const) {
		const { runtime, info } = harness(async () => {
			if (response instanceof Error) throw response;
			return response;
		});
		const event = bash("git status");
		await runtime.rewrite(event, context(), enabled);
		expect(event.input.command).toBe("git status");
		if (warning)
			expect(info).toHaveBeenCalledWith(
				expect.stringContaining("RTK query failed"),
				expect.objectContaining({ originalCommand: "git status", executionCommand: "git status" }),
				true,
			);
		else expect(info).not.toHaveBeenCalled();
	}
});

test("uses safe overlays after no-match but never overlays complex shell syntax", async () => {
	for (const [original, code, output, expected] of [
		["bun test", 1, "", "rtk test bun test"],
		["bun test", 0, "bun test", "rtk test bun test"],
		[
			"bun test && git status",
			3,
			"bun test && rtk git status",
			"rtk test bun test && rtk git status",
		],
		["find . -not -name tmp", 3, "rtk find . -not -name tmp", "find . -not -name tmp"],
		["bun --cwd test run", 0, "bun --cwd test run", "bun --cwd test run"],
		["$(echo unsafe) bun test", 0, "bun test", "bun test"],
	] as const) {
		const { runtime } = harness(async () => result(code, output));
		const event = bash(original);
		await runtime.rewrite(event, context(), enabled);
		expect(event.input.command).toBe(expected);
	}
	for (const command of [
		"echo 'unterminated",
		"echo $(unsafe)",
		'echo "unsafe \\" && bun test"',
		'echo "unsafe $value"',
		'echo "unsafe `value`"',
	])
		expect(splitRtkChain(command)).toBeNull();
});

test("reset aborts queries while reset and caller cancellation discard late results", async () => {
	let resolve: ((value: ExecResult) => void) | undefined;
	const signals: AbortSignal[] = [];
	const exec: ExtensionAPI["exec"] = (_command, _args, options) => {
		if (options?.signal) signals.push(options.signal);
		return new Promise<ExecResult>((done) => {
			resolve = done;
		});
	};
	const { runtime, info } = harness(exec);
	const resetEvent = bash("git status");
	const pending = runtime.rewrite(resetEvent, context(), enabled);
	runtime.reset();
	expect(signals[0]?.aborted).toBe(true);
	resolve?.(result(0, "rtk git status"));
	await pending;
	const controller = new AbortController();
	const cancelled = runtime.rewrite(bash("git diff"), context(controller.signal), enabled);
	controller.abort();
	expect(signals[1]?.aborted).toBe(true);
	resolve?.(result(0, "rtk git diff"));
	await cancelled;
	expect(resetEvent.input.command).toBe("git status");
	expect(info).not.toHaveBeenCalled();
});
