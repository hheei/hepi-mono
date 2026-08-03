import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry } from "@hheei/pi-ext-core";
import piT2sExtension from "../src/extension.js";

type Handler = (event: never, context: never) => unknown | Promise<unknown>;

function fakePi(): { readonly pi: ExtensionAPI; readonly handlers: Map<string, Handler[]> } {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (channel: string, handler: Handler) => {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

async function emit(
	handlers: Map<string, Handler[]>,
	channel: string,
	event: unknown,
	context: ExtensionContext,
): Promise<readonly unknown[]> {
	const results: unknown[] = [];
	for (const handler of handlers.get(channel) ?? []) {
		results.push(await handler(event as never, context as never));
	}
	return results;
}

function context(cwd: string, sessionId: string, notifications: string[]): ExtensionContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
}

describe("pi-t2s extension lifecycle", () => {
	test("chains interactive transforms and keeps one handler across session replacement", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-extension-"));
		const path = join(cwd, "settings.json");
		try {
			await Bun.write(
				path,
				JSON.stringify({ "pi-t2s": { "traditional-to-simplified": { mode: "t2s" } } }),
			);
			const { pi, handlers } = fakePi();
			piT2sExtension(pi, { settingsPath: path });
			const notifications: string[] = [];
			const first = context(cwd, "first", notifications);
			await emit(handlers, "session_start", { reason: "startup" }, first);

			expect(handlers.get("input")).toHaveLength(1);
			expect(await emit(handlers, "input", { text: "設定", source: "interactive" }, first)).toEqual(
				[{ action: "transform", text: "设定" }],
			);
			expect(await emit(handlers, "input", { text: "設定", source: "rpc" }, first)).toEqual([
				undefined,
			]);

			await emit(handlers, "session_shutdown", { reason: "switch" }, first);
			expect(await emit(handlers, "input", { text: "設定", source: "interactive" }, first)).toEqual(
				[undefined],
			);

			const second = context(cwd, "second", notifications);
			await emit(handlers, "session_start", { reason: "new" }, second);
			expect(handlers.get("input")).toHaveLength(1);
			expect(
				await emit(handlers, "input", { text: "設定", source: "interactive" }, second),
			).toEqual([{ action: "transform", text: "设定" }]);
			expect(notifications).toEqual([]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("registers settings while invalid configuration fails closed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-t2s-invalid-extension-"));
		const path = join(cwd, "settings.json");
		try {
			await Bun.write(
				path,
				JSON.stringify({ "pi-t2s": { "traditional-to-simplified": { mode: "invalid" } } }),
			);
			const { pi, handlers } = fakePi();
			piT2sExtension(pi, { settingsPath: path });
			const notifications: string[] = [];
			const ctx = context(cwd, "s", notifications);
			await emit(handlers, "session_start", { reason: "startup" }, ctx);

			const registry = getHepiRuntimeSettingsRegistry(pi);
			expect(registry.get("pi-t2s")?.origin).toBe("@hheei/pi-t2s");
			expect(await emit(handlers, "input", { text: "設定", source: "interactive" }, ctx)).toEqual([
				undefined,
			]);
			expect(notifications[0]).toContain("Unable to load T2S settings");

			await emit(handlers, "session_shutdown", { reason: "exit" }, ctx);
			expect(registry.get("pi-t2s")).toBeUndefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
