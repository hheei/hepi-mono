import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { createDisposerRegistry } from "../src/disposer-registry.js";
import {
	clearDisabledSkillKeys,
	getDisabledSkillKeys,
	isManagedTool,
	isSkillEnabled,
	observeLoadoutInventory,
	registerLoadoutResource,
	registerManagedTool,
	setDisabledSkillKeys,
	setManagedToolsActive,
} from "../src/index.js";

const OWNER = "@hheei/test-extension";

function registration(id: string, owner = OWNER) {
	return { id, owner } as const;
}

function agentResource(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		kind: "agent" as const,
		label: id.replace(/^agent:/u, ""),
		description: "Agent profile.",
		summary: "◔ inherit",
		projectPrivate: false,
		owner: OWNER,
		defaultActive: true,
		...overrides,
	};
}

function host(events: object = {}) {
	const registered: unknown[] = [];
	const activeTools = ["read"];
	const pi = {
		events,
		registerTool(tool: unknown) {
			registered.push(tool);
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(next: readonly string[]): void {
			activeTools.splice(0, activeTools.length, ...next);
		},
	} as unknown as ExtensionAPI;
	return { pi, registered, activeTools };
}

function observer(pi: ExtensionAPI) {
	const controller = new AbortController();
	const seen: string[][] = [];
	observeLoadoutInventory(pi, {
		signal: controller.signal,
		onChange(items) {
			seen.push(items.map((item) => item.id));
		},
	});
	return { controller, seen };
}

describe("Loadout core contract", () => {
	test("activates a managed bundle without changing unrelated tools and cleans it up", async () => {
		const h = host();
		registerManagedTool(h.pi, registration("alpha"), { name: "alpha" } as never);
		registerManagedTool(h.pi, registration("beta"), { name: "beta" } as never);
		const resources = createDisposerRegistry();
		const context = { pi: h.pi, resources } as never;
		setManagedToolsActive(context, [registration("alpha"), registration("beta")], true);
		expect(h.activeTools).toEqual(["read", "alpha", "beta"]);
		await resources.cleanup();
		expect(h.activeTools).toEqual(["read"]);
	});

	test("switches between managed catalogs without touching unrelated tools", () => {
		const h = host();
		registerManagedTool(h.pi, registration("alpha"), { name: "alpha" } as never);
		registerManagedTool(h.pi, registration("beta"), { name: "beta" } as never);
		const resources = createDisposerRegistry();
		const context = { pi: h.pi, resources } as never;
		setManagedToolsActive(context, [registration("alpha")], true);
		setManagedToolsActive(context, [registration("alpha")], false);
		setManagedToolsActive(context, [registration("beta")], true);
		expect(h.activeTools).toEqual(["read", "beta"]);
		setManagedToolsActive(context, [registration("beta")], false);
		setManagedToolsActive(context, [registration("alpha")], true);
		expect(h.activeTools).toEqual(["read", "alpha"]);
	});

	test("rejects bundles whose ids are unknown, foreign, or repeated", () => {
		const h = host();
		registerManagedTool(h.pi, registration("alpha"), { name: "alpha" } as never);
		const resources = createDisposerRegistry();
		const context = { pi: h.pi, resources } as never;
		expect(() => setManagedToolsActive(context, [registration("missing")], true)).toThrow(
			"Managed tool is not registered by owner: missing",
		);
		expect(() =>
			setManagedToolsActive(context, [registration("alpha", "@hheei/other")], true),
		).toThrow("Managed tool is not registered by owner: alpha");
		expect(() =>
			setManagedToolsActive(context, [registration("alpha"), registration("alpha")], true),
		).toThrow("Managed tool id is repeated: alpha");
		expect(h.activeTools).toEqual(["read"]);
	});

	test("requires a managed registration to match the Pi tool name", () => {
		const h = host();
		expect(() =>
			registerManagedTool(h.pi, registration("read"), { name: "grep" } as never),
		).toThrow("Managed tool id must match the Pi tool name: read");
		expect(h.registered).toHaveLength(0);
	});

	test("keeps a managed tool owned by one package across runners", () => {
		const events = {};
		const first = host(events);
		const second = host(events);
		registerManagedTool(first.pi, registration("read"), { name: "read" } as never);
		expect(() =>
			registerManagedTool(first.pi, registration("read"), { name: "read" } as never),
		).toThrow("Managed tool id already registered: read");
		registerManagedTool(second.pi, registration("read"), { name: "read" } as never);
		expect(first.registered).toHaveLength(1);
		expect(second.registered).toHaveLength(1);
		expect(isManagedTool(second.pi, "read")).toBe(true);
		expect(isManagedTool(second.pi, "grep")).toBe(false);
	});

	test("rejects a different owner claiming a managed tool name", () => {
		const events = {};
		const first = host(events);
		const second = host(events);
		registerManagedTool(first.pi, registration("read"), { name: "read" } as never);
		expect(() =>
			registerManagedTool(second.pi, registration("read", "@hheei/other"), {
				name: "read",
			} as never),
		).toThrow("Managed tool id already registered: read");
		expect(second.registered).toHaveLength(0);
	});

	test("registers and disposes a dynamic non-tool resource", () => {
		const h = host();
		const { controller, seen } = observer(h.pi);
		const dispose = registerLoadoutResource(h.pi, agentResource("agent:Explore"));
		expect(seen).toEqual([[], ["agent:Explore"]]);
		dispose();
		dispose();
		expect(seen).toEqual([[], ["agent:Explore"], []]);
		controller.abort();
		expect(h.activeTools).toEqual(["read"]);
	});

	test("rejects a duplicate resource id and an unsupported kind", () => {
		const h = host();
		registerLoadoutResource(h.pi, agentResource("agent:Explore"));
		expect(() => registerLoadoutResource(h.pi, agentResource("agent:Explore"))).toThrow(
			"Loadout resource id already registered: agent:Explore",
		);
		expect(() =>
			registerLoadoutResource(h.pi, agentResource("workflow:demo", { kind: "workflow" }) as never),
		).toThrow("Unsupported Loadout resource kind: workflow");
	});

	test("keeps resources committed after partial observer fanout", () => {
		const h = host();
		const successful = observer(h.pi);
		const throwingController = new AbortController();
		observeLoadoutInventory(h.pi, {
			signal: throwingController.signal,
			onChange(items) {
				if (items.length > 0) throw new Error("observer failed");
			},
		});
		const disposeFirst = registerLoadoutResource(h.pi, agentResource("agent:demo"));
		expect(successful.seen).toEqual([[], ["agent:demo"]]);
		throwingController.abort();
		const disposeSecond = registerLoadoutResource(h.pi, agentResource("agent:second"));
		expect(successful.seen.at(-1)).toEqual(["agent:demo", "agent:second"]);
		disposeFirst();
		disposeSecond();
		successful.controller.abort();
	});

	test("stops notifying aborted observers", async () => {
		const h = host();
		const { controller, seen } = observer(h.pi);
		const dispose = registerLoadoutResource(h.pi, agentResource("agent:demo"));
		controller.abort();
		dispose();
		expect(seen).toEqual([[], ["agent:demo"]]);
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
});
