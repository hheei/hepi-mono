import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { createDisposerRegistry } from "../src/disposer-registry.js";
import { setSessionToolsActive } from "../src/session-tools.js";

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

describe("setSessionToolsActive", () => {
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
});
