import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHePiModuleRegistry, type HePiModule } from "../../src/api/index.js";
import {
	dispatchHePiCommand,
	parseHePiCommand,
	registerHePiCommand,
} from "../../src/command/hepi-command.js";

function context(mode: string) {
	const notifications: Array<{ message: string; level?: string }> = [];
	let customCalls = 0;
	return {
		ctx: {
			mode,
			ui: {
				notify(message: string, level?: string) {
					notifications.push(level === undefined ? { message } : { message, level });
				},
				custom() {
					customCalls++;
					throw new Error("custom must not be called");
				},
			},
			sessionManager: { getSessionId: () => "session" },
		} as unknown as ExtensionCommandContext,
		notifications,
		get customCalls() {
			return customCalls;
		},
	};
}

describe("/hepi command", () => {
	test("parses subcommand and preserves trimmed remainder", () => {
		expect(parseHePiCommand("  setting   provider-id  ")).toEqual({
			subcommand: "setting",
			args: "provider-id",
		});
		expect(parseHePiCommand("   ")).toEqual({ subcommand: "", args: "" });
	});

	test("routes registered module and provider argument", async () => {
		const registry = createHePiModuleRegistry();
		let opened: { args: string; sessionId: string } | undefined;
		const module: HePiModule = {
			id: "settings",
			label: "Settings",
			commands: ["setting"],
			open: async (args, ctx) => {
				opened = { args, sessionId: ctx.sessionId };
			},
		};
		registry.register(module);
		const host = context("tui");
		await dispatchHePiCommand(" setting provider-id ", host.ctx, registry);
		expect(opened).toEqual({ args: "provider-id", sessionId: "session" });
		expect(host.notifications).toEqual([]);
	});

	test("reports empty and unknown subcommands", async () => {
		const registry = createHePiModuleRegistry();
		const empty = context("tui");
		await dispatchHePiCommand("", empty.ctx, registry);
		expect(empty.notifications[0]?.message).toContain("Usage: /hepi");
		const unknown = context("tui");
		await dispatchHePiCommand("missing", unknown.ctx, registry);
		expect(unknown.notifications[0]?.message).toContain("Unknown /hepi subcommand: missing");
	});

	test("guards non-TUI mode before module open", async () => {
		const registry = createHePiModuleRegistry();
		let opened = false;
		registry.register({
			id: "settings",
			label: "Settings",
			commands: ["setting"],
			open: async () => {
				opened = true;
			},
		});
		const host = context("json");
		await dispatchHePiCommand("setting provider-id", host.ctx, registry);
		expect(opened).toBe(false);
		expect(host.customCalls).toBe(0);
		expect(host.notifications[0]).toEqual({
			message: "/hepi setting requires TUI mode",
			level: "error",
		});
	});

	test("provides registered module command completions", () => {
		const registrations: Array<{
			options: { getArgumentCompletions?: (prefix: string) => unknown };
		}> = [];
		const pi = {
			registerCommand: (
				_name: string,
				options: { getArgumentCompletions?: (prefix: string) => unknown },
			) => registrations.push({ options }),
		} as unknown as ExtensionAPI;
		const registry = createHePiModuleRegistry();
		registry.register({
			id: "settings",
			label: "Settings",
			commands: ["setting"],
			open: async () => {},
		});
		registerHePiCommand(pi, registry);
		const completions = registrations[0]!.options.getArgumentCompletions?.("set") as Array<{
			value: string;
		}>;
		expect(completions.map((item) => item.value)).toEqual(["setting"]);
	});

	test("registers once per ExtensionAPI instance", async () => {
		const registrations: unknown[] = [];
		const pi = {
			registerCommand: (...args: unknown[]) => registrations.push(args),
		} as unknown as ExtensionAPI;
		const registry = createHePiModuleRegistry();
		registerHePiCommand(pi, registry);
		registerHePiCommand(pi, registry);
		expect(registrations).toHaveLength(1);
	});
});
