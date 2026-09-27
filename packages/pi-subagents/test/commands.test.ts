import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { bindParentStatus, formatStatusLine, registerParentCommands } from "../src/commands.js";
import type { PublicSubagent } from "../src/domain.js";
import type { SubagentManager } from "../src/manager.js";
import { child } from "./helpers/records.js";

describe("parent status line", () => {
	test("hides when every child is terminal and names interrupted TUI children", () => {
		expect(
			formatStatusLine([child({ state: "done" }), child({ state: "stopped" })]),
		).toBeUndefined();
		expect(
			formatStatusLine([
				child({ displayName: "Reviewer", state: "idle", mode: "tui", interrupted: "paused" }),
				child({ agent: "scout", state: "failed" }),
			]),
		).toBe("󰄰 Reviewer tui interrupted · 󰅚 scout failed");
	});

	test("bindParentStatus safely handles stale context during refresh and disposal", async () => {
		let listener: (() => void) | undefined;
		const manager = {
			list: vi.fn().mockResolvedValue([child({ state: "running" })]),
			onChange: vi.fn((fn: () => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			}),
		} as unknown as SubagentManager;

		const setStatus = vi.fn();
		const context = {
			ui: {
				setStatus,
			},
		} as unknown as ExtensionContext;

		const controller = new AbortController();
		const unbind = bindParentStatus({} as ExtensionAPI, context, manager, controller.signal);

		await Promise.resolve();
		expect(setStatus).toHaveBeenCalledWith("pi-subagents", "󰪠 worker running");

		// Simulate stale context throwing error
		Object.defineProperty(context, "ui", {
			get() {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		});

		// Trigger change after invalidation — must not throw or unhandled reject
		listener?.();
		await Promise.resolve();

		// Disposal on stale context — must not throw
		expect(() => unbind()).not.toThrow();
	});
});

function commandSetup(children: PublicSubagent[], mode = "tui") {
	const commands: {
		name: string;
		handler: (args: string, ctx: unknown) => Promise<void>;
		getArgumentCompletions?:
			| ((prefix: string) => { value: string; label: string }[] | null)
			| undefined;
	}[] = [];
	const pi = {
		registerCommand(
			name: string,
			command: {
				handler: (args: string, ctx: unknown) => Promise<void>;
				getArgumentCompletions?:
					| ((prefix: string) => { value: string; label: string }[] | null)
					| undefined;
			},
		) {
			commands.push({
				name,
				handler: command.handler,
				getArgumentCompletions: command.getArgumentCompletions,
			});
		},
		registerShortcut() {
			return undefined;
		},
	} as unknown as ExtensionAPI;
	const manager = {
		list: vi.fn(async () => children),
		attach: vi.fn(async () => ({})),
		stop: vi.fn(async () => ({})),
	} as unknown as SubagentManager;
	registerParentCommands(pi, manager);

	const notify = vi.fn();
	const select = vi.fn(async () => undefined);
	const ctx = {
		mode,
		ui: { notify, select, input: vi.fn(async () => undefined), setStatus: vi.fn() },
	} as unknown as ExtensionCommandContext;
	return {
		names: commands.map((command) => command.name),
		completions: () => commands[0]?.getArgumentCompletions,
		run: (args: string) => commands[0]?.handler(args, ctx),
		manager,
		notify,
		select,
	};
}

describe("/subagents command", () => {
	test("registers one command surface instead of one command per action", () => {
		expect(commandSetup([]).names).toEqual(["subagents"]);
		expect(commandSetup([]).completions()?.("ins")).toEqual([
			{ value: "inspect", label: "inspect" },
		]);
		expect(commandSetup([]).completions()?.("nope")).toBeNull();
	});

	test("attaches and stops by id without opening the picker", async () => {
		// Two matching children: only an explicit id keeps the picker closed.
		const idle = [
			child({ id: "sa_idle1", state: "idle" }),
			child({ id: "sa_idle2", state: "idle" }),
		];
		const attach = commandSetup(idle);
		await attach.run("attach sa_idle2");
		expect(attach.manager.attach).toHaveBeenCalledWith("sa_idle2");
		expect(attach.select).not.toHaveBeenCalled();
		expect(attach.notify).toHaveBeenCalledWith("Attached sa_idle2");

		const live = [
			child({ id: "sa_live1", state: "running" }),
			child({ id: "sa_live2", state: "running" }),
		];
		const stop = commandSetup(live);
		await stop.run("stop sa_live1");
		expect(stop.manager.stop).toHaveBeenCalledWith("sa_live1");
		expect(stop.select).not.toHaveBeenCalled();
		expect(stop.notify).toHaveBeenCalledWith("Stopped sa_live1");
	});

	test("falls back to the picker when attach or stop has no id", async () => {
		const attach = commandSetup([
			child({ id: "sa_idle1", state: "idle" }),
			child({ id: "sa_idle2", state: "idle" }),
		]);
		await attach.run("attach");
		expect(attach.select).toHaveBeenCalledWith("Attach idle subagent", [
			expect.stringContaining("sa_idle1"),
			expect.stringContaining("sa_idle2"),
		]);
		// The picker was cancelled, so nothing was attached and no id was invented.
		expect(attach.manager.attach).not.toHaveBeenCalled();

		const stop = commandSetup([
			child({ id: "sa_live1", state: "running" }),
			child({ id: "sa_live2", state: "running" }),
		]);
		await stop.run("stop");
		expect(stop.select).toHaveBeenCalledWith("Stop subagent", [
			expect.stringContaining("sa_live1"),
			expect.stringContaining("sa_live2"),
		]);
		expect(stop.manager.stop).not.toHaveBeenCalled();
	});

	test("rejects an unknown subcommand with the usage line", async () => {
		const command = commandSetup([]);
		await command.run("maybe");
		expect(command.notify).toHaveBeenCalledWith(
			'Unknown subcommand "maybe". Usage: /subagents list|inspect|attach [id]|send|stop [id]',
			"warning",
		);
	});

	test("points at the model tools outside TUI mode", async () => {
		const command = commandSetup([], "rpc");
		await command.run("list");
		expect(command.notify).toHaveBeenCalledWith(
			"Use spawn_subagent / send_subagent / get_subagent / stop_subagent in this mode",
		);
	});
});
