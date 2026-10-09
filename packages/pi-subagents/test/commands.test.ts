import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { registerParentCommands } from "../src/commands.js";
import type { PublicSubagent } from "../src/domain.js";
import type { SubagentManager } from "../src/manager.js";
import { child } from "./helpers/records.js";

function commandSetup(children: PublicSubagent[], mode = "tui") {
	const commands: {
		name: string;
		handler: (args: string, ctx: unknown) => Promise<void>;
		getArgumentCompletions?:
			| ((prefix: string) => { value: string; label: string }[] | null)
			| undefined;
	}[] = [];
	const shortcuts: string[] = [];
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
		registerShortcut(name: string) {
			shortcuts.push(name);
			return undefined;
		},
	} as unknown as ExtensionAPI;
	const manager = {
		list: vi.fn(async () => children),
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
		shortcuts,
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

	test("exposes no attach verb and registers no global shortcuts", () => {
		// Attaching was a hand-off between transports; a child is presented where it was spawned.
		const setup = commandSetup([]);
		expect(setup.completions()?.("att")).toBeNull();
		expect(setup.shortcuts).toEqual([]);
	});

	test("stops by id without opening the picker", async () => {
		// Two matching children: only an explicit id keeps the picker closed.
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

	test("falls back to the picker when stop has no id", async () => {
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
			'Unknown subcommand "maybe". Usage: /subagents list|inspect|send|stop [id]',
			"warning",
		);
	});

	test("points at the model tools outside TUI mode", async () => {
		const command = commandSetup([], "rpc");
		await command.run("list");
		expect(command.notify).toHaveBeenCalledWith(
			"Use spawn_agent / send_agent / get_agent / stop_agent in this mode",
		);
	});
});
