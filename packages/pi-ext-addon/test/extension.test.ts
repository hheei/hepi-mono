import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRuntimeSettingsRegistry } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import piExtAddonExtension from "../src/extension.js";

function fakePi() {
	const handlers = new Map<
		string,
		Array<(event: unknown, context?: unknown) => void | Promise<void>>
	>();
	const commands = new Map<string, unknown>();
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
		registerCommand: (name: string, config: unknown) => {
			commands.set(name, config);
		},
		getCommands: () => [],
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands };
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
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			addAutocompleteProvider: () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => undefined,
		},
		mode: "tui",
		hasUI: true,
	} as unknown as ExtensionContext;
}

describe("pi-ext-addon extension lifecycle", () => {
	test("registers addon settings providers and cleans up on shutdown", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-addon-ext-"));
		try {
			const { pi, handlers, commands } = fakePi();
			piExtAddonExtension(pi);

			expect(commands.has("auto-title")).toBe(true);
			expect(handlers.get("session_start")?.length).toBeGreaterThan(0);
			expect(handlers.get("session_shutdown")?.length).toBeGreaterThan(0);

			await emit(handlers, "session_start", { reason: "startup" }, fakeExtension(dir));

			const registry = getRuntimeSettingsRegistry(pi);
			expect(registry.get("dollar-skill")?.id).toBe("dollar-skill");
			expect(registry.get("auto-title")?.id).toBe("auto-title");

			await emit(handlers, "session_shutdown", {}, fakeExtension(dir));
			expect(registry.get("dollar-skill")).toBeUndefined();
			expect(registry.get("auto-title")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
