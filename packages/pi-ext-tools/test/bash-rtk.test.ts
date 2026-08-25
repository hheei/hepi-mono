import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import type { FffRuntimeState } from "../src/fff/lifecycle.js";
import { DEFAULT_FFF_SETTINGS } from "../src/fff/settings.js";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type ExecCall = {
	readonly command: string;
	readonly args: string[];
	readonly timeout: number | undefined;
	readonly signal: AbortSignal | undefined;
};

type ToolCallHandler = (
	event: { toolName: string; input: Record<string, unknown> },
	context: unknown,
) => Promise<unknown>;

function execResult(code: number, stdout = "", stderr = "", killed = false): ExecResult {
	return { code, stdout, stderr, killed };
}

function registerRtk(
	exec: ExtensionAPI["exec"],
	enabled = true,
	path = "",
): { readonly hook: ToolCallHandler; readonly tool: ToolDefinition } {
	let handler: ToolCallHandler | undefined;
	let tool: ToolDefinition | undefined;
	let warnings = 0;
	const state: FffRuntimeState = {
		getRuntime: () => undefined,
		getSettings: () => DEFAULT_FFF_SETTINGS,
		getRtkSettings: () => ({ enabled, path }),
		getBashJobs: () => undefined,
		getOutputs: () => undefined,
		getTargetRuntime: () => undefined,
		consumeRtkRewriteWarning: () => {
			if (warnings > 0) return false;
			warnings++;
			return true;
		},
	};
	registerBashTool(
		{
			registerTool: (registered: ToolDefinition): void => {
				tool = registered;
			},
			on: (event: string, callback: ToolCallHandler): void => {
				if (event === "tool_call") handler = callback;
			},
			exec,
		} as unknown as ExtensionAPI,
		state,
	);
	if (handler === undefined) throw new Error("Expected RTK tool_call hook");
	if (tool === undefined) throw new Error("Expected bash tool");
	return { hook: handler, tool };
}

function registerRtkHook(exec: ExtensionAPI["exec"], enabled = true, path = ""): ToolCallHandler {
	return registerRtk(exec, enabled, path).hook;
}

function toolCall(
	command: string,
	input: Record<string, unknown> = {},
): { toolName: string; input: Record<string, unknown> } {
	return { toolName: "bash", input: { command, ...input } };
}

const context = (notices: string[]) => ({
	hasUI: true,
	ui: {
		notify: (message: string): void => {
			notices.push(message);
		},
	},
});

test("RTK rewrites only default foreground Bash commands", async (): Promise<void> => {
	const calls: Array<{ command: string; args: string[]; timeout: number | undefined }> = [];
	const hook = registerRtkHook(async (command, args, options) => {
		calls.push({ command, args, timeout: options?.timeout });
		return execResult(3, "rtk git status");
	});
	const notices: string[] = [];
	const foreground = toolCall("git status");
	await hook(foreground, context(notices));
	await hook(toolCall("git status", { async: true }), context(notices));
	await hook(toolCall("git status", { pty: true }), context(notices));
	await hook(toolCall("git status", { target: "ileqm" }), context(notices));
	await hook(toolCall("git status", { target: "output" }), context(notices));
	await hook(toolCall("rtk git status"), context(notices));

	expect(foreground.input.command).toBe("rtk git status");
	expect(calls).toEqual([{ command: "rtk", args: ["rewrite", "git status"], timeout: 1_000 }]);
	expect(notices).toEqual([]);
});

test("RTK uses configured executable path", async (): Promise<void> => {
	const calls: string[] = [];
	const hook = registerRtkHook(
		async (command) => {
			calls.push(command);
			return execResult(0, "rtk git status");
		},
		true,
		"/tools/rtk",
	);
	await hook(toolCall("git status"), context([]));

	expect(calls).toEqual(["/tools/rtk"]);
});

test("RTK disabled leaves Bash unchanged", async (): Promise<void> => {
	let calls = 0;
	const hook = registerRtkHook(async () => {
		calls++;
		return execResult(3, "rtk git status");
	}, false);
	const event = toolCall("git status");
	await hook(event, context([]));

	expect(event.input.command).toBe("git status");
	expect(calls).toBe(0);
});

test("RTK no-match leaves Bash unchanged without a warning", async (): Promise<void> => {
	const hook = registerRtkHook(async () => execResult(1));
	const notices: string[] = [];
	const event = toolCall("echo hello");
	await hook(event, context(notices));

	expect(event.input.command).toBe("echo hello");
	expect(notices).toEqual([]);
});

test("RTK failure warns once and runs original Bash command", async (): Promise<void> => {
	const hook = registerRtkHook(async () => {
		throw new Error("spawn rtk ENOENT");
	});
	const notices: string[] = [];
	const first = toolCall("git status");
	const second = toolCall("git diff");
	await hook(first, context(notices));
	await hook(second, context(notices));

	expect(first.input.command).toBe("git status");
	expect(second.input.command).toBe("git diff");
	expect(notices).toEqual([
		"RTK rewrite unavailable (spawn rtk ENOENT); running original Bash command",
	]);
});

test("RTK abort during rewrite does not apply a rewrite or warn", async (): Promise<void> => {
	const controller = new AbortController();
	const calls: ExecCall[] = [];
	const hook = registerRtkHook(async (command, args, options) => {
		calls.push({
			command,
			args,
			timeout: options?.timeout,
			signal: options?.signal,
		});
		controller.abort();
		return execResult(0, "rtk git status", "", true);
	});
	const notices: string[] = [];
	const event = toolCall("git status");
	await hook(event, { ...context(notices), signal: controller.signal });

	expect(event.input.command).toBe("git status");
	expect(calls).toEqual([
		{
			command: "rtk",
			args: ["rewrite", "git status"],
			timeout: 1_000,
			signal: controller.signal,
		},
	]);
	expect(notices).toEqual([]);
});

test("aborted signal skips foreground Bash spawn", async (): Promise<void> => {
	const { tool } = registerRtk(async () => execResult(3, "rtk true"));
	const controller = new AbortController();
	controller.abort();
	const result = await tool.execute(
		"bash-aborted-prespawn",
		{ command: "printf spawned" },
		controller.signal,
		() => undefined,
		{ cwd: process.cwd() } as ExtensionContext,
	);
	expect(result).toMatchObject({
		content: [{ type: "text", text: "Bash aborted" }],
		details: { error: "aborted" },
	});
});

test("RTK empty rewrite output warns once", async (): Promise<void> => {
	for (const code of [0, 3]) {
		const hook = registerRtkHook(async () => execResult(code, "   "));
		const notices: string[] = [];
		const first = toolCall("git status");
		const second = toolCall("git diff");
		await hook(first, context(notices));
		await hook(second, context(notices));

		expect(first.input.command).toBe("git status");
		expect(second.input.command).toBe("git diff");
		expect(notices).toEqual([
			"RTK rewrite failed (rtk returned empty output); running original Bash command",
		]);
	}
});

test("RTK timeout warns once and keeps the original command", async (): Promise<void> => {
	const hook = registerRtkHook(async () => execResult(0, "rtk git status", "", true));
	const notices: string[] = [];
	const first = toolCall("git status");
	const second = toolCall("git diff");
	await hook(first, context(notices));
	await hook(second, context(notices));

	expect(first.input.command).toBe("git status");
	expect(second.input.command).toBe("git diff");
	expect(notices).toEqual(["RTK rewrite failed (timeout); running original Bash command"]);
});

test("RTK exit 2 warns once and keeps the original command", async (): Promise<void> => {
	const hook = registerRtkHook(async () => execResult(2, "", "rtk denied rewrite"));
	const notices: string[] = [];
	const event = toolCall("git status");
	await hook(event, context(notices));

	expect(event.input.command).toBe("git status");
	expect(notices).toEqual([
		"RTK rewrite failed (rtk denied rewrite); running original Bash command",
	]);
});

test("RTK skips whitespace-only commands", async (): Promise<void> => {
	let calls = 0;
	const hook = registerRtkHook(async () => {
		calls++;
		return execResult(3, "rtk true");
	});
	const event = toolCall("   \n\t");
	await hook(event, context([]));

	expect(event.input.command).toBe("   \n\t");
	expect(calls).toBe(0);
});

test("RTK bypasses env-prefixed rtk commands", async (): Promise<void> => {
	let calls = 0;
	const hook = registerRtkHook(async () => {
		calls++;
		return execResult(3, "rtk git status");
	});
	const event = toolCall("FOO=bar rtk git status");
	await hook(event, context([]));

	expect(event.input.command).toBe("FOO=bar rtk git status");
	expect(calls).toBe(0);
});

test("RTK fallback stays silent without UI", async (): Promise<void> => {
	const hook = registerRtkHook(async () => {
		throw new Error("spawn rtk ENOENT");
	});
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message?: unknown): void => {
		warnings.push(String(message));
	};
	try {
		const event = toolCall("git status");
		await hook(event, { hasUI: false, ui: { notify: (): void => undefined } });
		expect(event.input.command).toBe("git status");
		expect(warnings).toEqual([]);
	} finally {
		console.warn = originalWarn;
	}
});
