import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerOmCommand } from "../src/commands/om.js";
import type { Runtime } from "../src/runtime.js";
import {
	foldLedger,
	latestGateEnabled,
	rawTokensSinceObservationCoverage,
} from "../src/session-ledger/index.js";
import type { TestEntry } from "./fixtures/session.js";
import {
	gateEntry,
	observation,
	observationsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

type NotifyLevel = "info" | "warning" | "error";

type GateCtx = {
	cwd: string;
	ui: { notify: (message: string, level?: NotifyLevel) => void };
	sessionManager: { getBranch: () => unknown };
};

function setup(entries: TestEntry[] = []) {
	let branch = [...entries];
	let handler: ((args: unknown, ctx: GateCtx) => Promise<void>) | undefined;
	let completions: ((prefix: string) => { value: string; label: string }[] | null) | undefined;
	const pi = {
		registerCommand: vi.fn(
			(
				name: string,
				command: {
					handler: typeof handler;
					getArgumentCompletions?:
						| ((prefix: string) => { value: string; label: string }[] | null)
						| undefined;
				},
			) => {
				expect(name).toBe("om");
				handler = command.handler;
				completions = command.getArgumentCompletions;
			},
		),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			branch = [
				...branch,
				{
					type: "custom",
					id,
					parentId: branch.at(-1)?.id ?? null,
					timestamp: "2026-05-02T10:00:00.000Z",
					customType,
					data,
				},
			];
			return id;
		}),
	};
	registerOmCommand(pi as unknown as ExtensionAPI, {} as unknown as Runtime);
	if (!handler) throw new Error("/om handler not registered");

	const notify = vi.fn();
	const ctx: GateCtx = {
		cwd: "/tmp/project",
		ui: { notify },
		sessionManager: { getBranch: () => branch },
	};
	return {
		pi,
		completions: () => completions,
		run: async (args?: string) => {
			await handler!(args, ctx);
			return notify.mock.calls.at(-1)?.[0] as string;
		},
		lastNotify: () => notify.mock.calls.at(-1)?.[0] as string,
		notifyCount: () => notify.mock.calls.length,
		getBranch: () => branch,
	};
}

describe("/om gate", () => {
	it("reports the current state without writing an entry", async () => {
		const gate = setup();
		expect(await gate.run()).toContain("Observational memory is on for this session");
		expect(gate.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("turns the gate off and on through branch entries", async () => {
		const gate = setup();

		expect(await gate.run("off")).toContain("is off for this session");
		expect(gate.pi.appendEntry).toHaveBeenLastCalledWith("om.gate", { enabled: false });
		expect(latestGateEnabled(gate.getBranch())).toBe(false);

		expect(await gate.run("on")).toContain("is on for this session");
		expect(gate.pi.appendEntry).toHaveBeenLastCalledWith("om.gate", { enabled: true });
		expect(latestGateEnabled(gate.getBranch())).toBe(true);
	});

	it("accepts whitespace and mixed case arguments", async () => {
		const gate = setup();
		await gate.run("  OFF  ");
		expect(latestGateEnabled(gate.getBranch())).toBe(false);
	});

	it("does not append a redundant entry when the state already matches", async () => {
		const gate = setup([gateEntry("gate-1", true)]);
		expect(await gate.run("on")).toContain("already on");
		expect(gate.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("rejects unknown subcommands and points at the usage line", async () => {
		const gate = setup();
		const message = await gate.run("maybe");
		expect(message).toContain('Unknown subcommand "maybe"');
		expect(message).toContain("Usage: /om on|off|status|view|consolidate|compact");
		expect(gate.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("rejects a stray word after on or off instead of ignoring it", async () => {
		const gate = setup();
		const message = await gate.run("on maybe");
		expect(message).toContain("Usage: /om on|off|status|view|consolidate|compact");
		expect(gate.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("reads the newest gate entry so a later toggle wins", async () => {
		const gate = setup([gateEntry("gate-1", false), gateEntry("gate-2", true)]);
		expect(await gate.run()).toContain("Observational memory is on");
	});

	it("keeps the gate entry out of the memory fold and the token clocks", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			gateEntry("gate-1", false),
		];

		const folded = foldLedger(entries);
		expect(folded.observations).toHaveLength(1);
		expect(folded.activeObservations).toHaveLength(1);
		// A gate entry is not a source entry, so it must not move coverage clocks.
		expect(rawTokensSinceObservationCoverage(entries)).toBe(0);
	});

	it("completes its subcommands and the view argument", () => {
		const completions = setup().completions();
		expect(completions?.("vi")).toEqual([{ value: "view", label: "view" }]);
		expect(completions?.("view f")).toEqual([{ value: "view full", label: "full" }]);
		expect(completions?.("nope")).toBeNull();
	});
});
