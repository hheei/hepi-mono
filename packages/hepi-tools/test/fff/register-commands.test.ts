import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ALL_FEATURE_KEYS, type FeatureKey } from "../../src/fff/extension-common.js";
import { registerCommands } from "../../src/fff/register-commands.js";

describe("FFF commands", () => {
	test("persists feature changes for reload without mutating the active runtime", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const saved: Set<FeatureKey>[] = [];
		const notices: string[] = [];
		registerCommands(
			{
				registerCommand(
					name: string,
					command: { readonly handler: (args: string, ctx: unknown) => Promise<void> },
				) {
					if (name === "fff-features") handler = command.handler;
				},
			} as unknown as ExtensionAPI,
			{
				getRuntime: () => null,
				isFeatureEnabled: () => true,
				getEnabledFeatures: () => new Set(ALL_FEATURE_KEYS),
				persistFeatures: async (next) => {
					saved.push(next);
				},
			},
		);
		if (handler === undefined) throw new Error("Expected /fff-features command");

		await handler("", {
			ui: {
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						kb: unknown,
						done: () => void,
					) => {
						handleInput(input: string): void;
					},
				) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_style: string, text: string) => text, bold: (text: string) => text },
						undefined,
						() => undefined,
					);
					component.handleInput(" ");
					component.handleInput("\r");
				},
				notify: (message: string) => notices.push(message),
			},
		});
		await Promise.resolve();

		expect(saved).toEqual([
			new Set(ALL_FEATURE_KEYS.filter((feature) => feature !== "autocomplete")),
		]);
		expect(notices).toEqual(["pi-fff features saved (4 enabled). Run /reload to apply them."]);
	});
});
