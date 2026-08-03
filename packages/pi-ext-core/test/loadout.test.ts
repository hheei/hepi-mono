import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDisposerRegistry } from "../src/disposer-registry.js";
import {
	clearDisabledSkillKeys,
	clearLoadoutToolActivation,
	getDisabledSkillKeys,
	isSkillEnabled,
	observeLoadoutInventory,
	observeLoadoutToolActivation,
	publishLoadoutToolActivation,
	registerLoadoutInventory,
	registerLoadoutResource,
	registerManagedLoadoutTool,
	setDisabledSkillKeys,
} from "../src/index.js";

function metadata(id: string, owner = "@hheei/test-extension") {
	return {
		id,
		owner,
		group: "tools",
		priority: 10,
		conflictSets: [],
		defaultActive: true,
	} as const;
}

function host(events: object = {}) {
	const registered: unknown[] = [];
	const pi = {
		events,
		registerTool(tool: unknown) {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

describe("Loadout core contract", () => {
	test("registers managed tools and publishes inventory snapshots", () => {
		const h = host();
		const controller = new AbortController();
		const snapshots: string[][] = [];
		observeLoadoutInventory(h.pi, {
			signal: controller.signal,
			onChange(items) {
				snapshots.push(items.map((item) => item.id));
			},
		});
		registerManagedLoadoutTool(
			h.pi,
			{
				...metadata("find_files"),
			},
			{ name: "find_files" } as never,
		);
		expect(h.registered).toHaveLength(1);
		expect(snapshots).toEqual([[], ["find_files"]]);
	});

	test("rejects duplicate inventory IDs and keeps the first registration", () => {
		const h = host();
		const resources = createDisposerRegistry();
		const context = { pi: h.pi, resources } as never;
		registerLoadoutInventory(context, metadata("read"));
		expect(() => registerLoadoutInventory(context, metadata("read"))).toThrow(
			"Loadout tool id already registered: read",
		);
	});

	test("requires managed metadata to match the Pi tool name", () => {
		const h = host();
		expect(() =>
			registerManagedLoadoutTool(h.pi, metadata("read"), { name: "grep" } as never),
		).toThrow("Loadout tool id must match the Pi tool name: read");
		expect(h.registered).toHaveLength(0);
	});

	test("replaces a managed registration on a new runner for the same owner", () => {
		const events = {};
		const first = host(events);
		const second = host(events);
		registerManagedLoadoutTool(first.pi, metadata("read"), { name: "read" } as never);
		registerManagedLoadoutTool(second.pi, metadata("read"), { name: "read" } as never);
		expect(first.registered).toHaveLength(1);
		expect(second.registered).toHaveLength(1);
	});

	test("rejects a different owner claiming a managed tool name", () => {
		const events = {};
		const first = host(events);
		const second = host(events);
		registerManagedLoadoutTool(first.pi, metadata("read"), { name: "read" } as never);
		expect(() =>
			registerManagedLoadoutTool(second.pi, metadata("read", "@hheei/other"), {
				name: "read",
			} as never),
		).toThrow("Loadout tool id already registered: read");
		expect(second.registered).toHaveLength(0);
	});

	test("removes lifecycle inventory and stops aborted observers", async () => {
		const h = host();
		const resources = createDisposerRegistry();
		const context = { pi: h.pi, resources } as never;
		const controller = new AbortController();
		const seen: string[][] = [];
		observeLoadoutInventory(h.pi, {
			signal: controller.signal,
			onChange(items) {
				seen.push(items.map((item) => item.id));
			},
		});
		registerLoadoutInventory(context, metadata("grep"));
		await resources.cleanup();
		controller.abort();
		registerManagedLoadoutTool(h.pi, metadata("read"), { name: "read" } as never);
		expect(seen).toEqual([[], ["grep"], []]);
	});

	test("registers and disposes a dynamic non-tool resource", () => {
		const h = host();
		const controller = new AbortController();
		const seen: string[][] = [];
		observeLoadoutInventory(h.pi, {
			signal: controller.signal,
			onChange(items) {
				seen.push(items.map((item) => item.id));
			},
		});
		const dispose = registerLoadoutResource(h.pi, {
			...metadata("agent:Explore"),
			kind: "agent",
			label: "Explore",
			description: "Read-only explorer.",
			summary: "◔ cx/gpt-5.6-luna",
			projectPrivate: false,
		});
		expect(seen).toEqual([[], ["agent:Explore"]]);
		dispose();
		dispose();
		expect(seen).toEqual([[], ["agent:Explore"], []]);
	});

	test("publishes canonical disabled skill state and clears it", () => {
		const h = host();
		setDisabledSkillKeys(h.pi, ["lint", "skill:format"]);
		expect([...getDisabledSkillKeys(h.pi)]).toEqual(["skill:lint", "skill:format"]);
		expect(isSkillEnabled(h.pi, "lint")).toBe(false);
		expect(isSkillEnabled(h.pi, "skill:other")).toBe(true);
		clearDisabledSkillKeys(h.pi);
		expect(isSkillEnabled(h.pi, "lint")).toBe(true);
	});

	test("publishes activation only for known tool ids and cleans up observers", () => {
		const h = host();
		const controller = new AbortController();
		const seen: string[] = [];
		observeLoadoutToolActivation(h.pi, {
			signal: controller.signal,
			onChange(snapshot) {
				seen.push(snapshot === undefined ? "none" : [...snapshot.activeIds].join(","));
			},
		});
		expect(seen).toEqual(["none"]);
		expect(() =>
			publishLoadoutToolActivation(h.pi, {
				knownIds: new Set(["read"]),
				activeIds: new Set(["find"]),
			}),
		).toThrow("Loadout active tool is not known: find");
		publishLoadoutToolActivation(h.pi, {
			knownIds: new Set(["find", "read"]),
			activeIds: new Set(["read"]),
		});
		clearLoadoutToolActivation(h.pi);
		controller.abort();
		publishLoadoutToolActivation(h.pi, {
			knownIds: new Set(["find"]),
			activeIds: new Set(["find"]),
		});
		expect(seen).toEqual(["none", "read", "none"]);
	});
});
