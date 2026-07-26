import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHePiModuleRegistry, type HePiModule } from "../../src/core/api/index.js";
import {
	dispatchHePiCommand,
	parseHePiCommand,
	registerHePiCommand,
} from "../../src/core/command/hepi-command.js";

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
		expect(parseHePiCommand("  loadout   provider-id  ")).toEqual({
			subcommand: "loadout",
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
			commands: ["loadout"],
			open: async (args, ctx) => {
				opened = { args, sessionId: ctx.sessionId };
			},
		};
		registry.register(module);
		const host = context("tui");
		await dispatchHePiCommand(" loadout provider-id ", host.ctx, registry);
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
		const legacySettings = context("tui");
		await dispatchHePiCommand("setting", legacySettings.ctx, registry);
		expect(legacySettings.notifications[0]?.message).toContain("Unknown /hepi subcommand: setting");
	});

	test("guards non-TUI mode before module open", async () => {
		const registry = createHePiModuleRegistry();
		let opened = false;
		registry.register({
			id: "settings",
			label: "Settings",
			commands: ["loadout"],
			open: async () => {
				opened = true;
			},
		});
		const host = context("json");
		await dispatchHePiCommand("loadout provider-id", host.ctx, registry);
		expect(opened).toBe(false);
		expect(host.customCalls).toBe(0);
		expect(host.notifications[0]).toEqual({
			message: "/hepi loadout requires TUI mode",
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
			commands: ["loadout"],
			open: async () => {},
		});
		registerHePiCommand(pi, registry);
		const hepi = registrations.find(({ options }) => options.getArgumentCompletions !== undefined);
		const completions = hepi?.options.getArgumentCompletions?.("loa") as Array<{
			value: string;
		}>;
		expect(completions.map((item) => item.value)).toEqual(["loadout"]);
	});

	test("opens settings through /ext-settings without a legacy route", async () => {
		const registrations: Array<{
			name: string;
			options: {
				handler?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			};
		}> = [];
		const pi = {
			registerCommand: (
				name: string,
				options: {
					handler?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
				},
			) => registrations.push({ name, options }),
		} as unknown as ExtensionAPI;
		const registry = createHePiModuleRegistry();
		let opened = false;
		registry.register({
			id: "setting",
			label: "Settings",
			commands: ["loadout"],
			open: async (_args, ctx) => {
				opened = ctx.command === "setting";
			},
		});
		registerHePiCommand(pi, registry);
		const extSettings = registrations.find(({ name }) => name === "ext-settings");
		await extSettings?.options.handler?.("", context("tui").ctx);
		expect(opened).toBe(true);
	});

	test("registers once per ExtensionAPI instance", async () => {
		const registrations: unknown[] = [];
		const pi = {
			registerCommand: (...args: unknown[]) => registrations.push(args),
		} as unknown as ExtensionAPI;
		const registry = createHePiModuleRegistry();
		registerHePiCommand(pi, registry);
		registerHePiCommand(pi, registry);
		expect(registrations).toHaveLength(3);
	});
});
