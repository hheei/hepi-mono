import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry, registerLoadoutResource } from "@hheei/pi-ext-core";
import piAutoTitleExtension from "../src/extension.js";

function fakePi() {
	const handlers = new Map<
		string,
		Array<(event: unknown, context?: unknown) => void | Promise<void>>
	>();
	const pi = {
		on: (channel: string, handler: (event: unknown, context?: unknown) => void | Promise<void>) => {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

async function emit(
	handlers: Map<string, Array<(event: unknown, context?: unknown) => void | Promise<void>>>,
	channel: string,
	event: unknown,
	context: ExtensionContext,
): Promise<void> {
	for (const handler of handlers.get(channel) ?? []) {
		await handler(event, context);
	}
}

function fakeExtension(cwd: string): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => "s", getEntries: () => [] },
		modelRegistry: {
			getAvailable: () => [],
			hasConfiguredAuth: () => false,
			find: () => undefined,
		},
		cwd,
		ui: { notify: () => undefined },
		mode: "tui",
		hasUI: true,
	} as unknown as ExtensionContext;
}

describe("pi-auto-title extension lifecycle", () => {
	test("registers /ext-settings, contributes no Loadout agent resource, and unregisters on shutdown", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-auto-title-ext-"));
		try {
			const { pi, handlers } = fakePi();
			piAutoTitleExtension(pi);

			expect(handlers.get("session_start")?.length).toBeGreaterThan(0);
			expect(handlers.get("session_shutdown")?.length).toBeGreaterThan(0);

			await emit(handlers, "session_start", { reason: "startup" }, fakeExtension(dir));

			const registry = getHepiRuntimeSettingsRegistry(pi);
			expect(registry.get("pi-auto-title")?.id).toBe("pi-auto-title");

			// Auto Title must not register a Loadout resource: registering the
			// same id manually must not collide (it would throw if already taken).
			const disposeResource = registerLoadoutResource(pi, {
				id: "agent:auto-title",
				kind: "agent",
				group: "hepi",
				label: "Auto Title",
				description: "Generate concise session titles automatically.",
				summary: "Automatic session titles",
				owner: "@hheei/pi-auto-title",
				priority: 50,
				conflictSets: [],
				defaultActive: true,
				projectPrivate: false,
			});
			disposeResource();

			await emit(handlers, "session_shutdown", {}, fakeExtension(dir));
			expect(registry.get("pi-auto-title")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
