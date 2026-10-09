import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { createDisposerRegistry } from "../src/disposer-registry.js";
import {
	clearDisabledSkillKeys,
	getDisabledSkillKeys,
	isSkillEnabled,
	observeLoadoutInventory,
	registerLoadoutResource,
	setDisabledSkillKeys,
	setSessionToolsActive,
} from "../src/index.js";

const OWNER = "@hheei/test-extension";

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
	test("activates session tools without changing unrelated tools and cleans them up", async () => {
		const h = host();
		const resources = createDisposerRegistry();
		const context = { pi: h.pi, resources } as never;
		setSessionToolsActive(context, ["alpha", "beta"], true);
		expect(h.activeTools).toEqual(["read", "alpha", "beta"]);
		await resources.cleanup();
		expect(h.activeTools).toEqual(["read"]);
	});

	test("switches between session tool sets without touching unrelated tools", () => {
		const h = host();
		const resources = createDisposerRegistry();
		const context = { pi: h.pi, resources } as never;
		setSessionToolsActive(context, ["alpha"], true);
		setSessionToolsActive(context, ["alpha"], false);
		setSessionToolsActive(context, ["beta"], true);
		expect(h.activeTools).toEqual(["read", "beta"]);
		setSessionToolsActive(context, ["beta"], false);
		setSessionToolsActive(context, ["alpha"], true);
		expect(h.activeTools).toEqual(["read", "alpha"]);
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
