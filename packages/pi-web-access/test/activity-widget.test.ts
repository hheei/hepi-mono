import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { activityMonitor } from "../src/activity.ts";
import webAccessExtension from "../src/index.ts";

interface Host {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly widgets: string[];
	readonly fire: (event: string) => Promise<void>;
	readonly pressActivityShortcut: () => Promise<void>;
}

/** One extension instance with the activity widget switched on through its real shortcut. */
function host(): Host {
	const listeners = new Map<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]>();
	const shortcuts = new Map<string, () => Promise<void>>();
	const widgets: string[] = [];
	const context = {
		ui: {
			theme: { fg: (_role: string, text: string): string => text },
			setWidget: (id: string, content: unknown): void => {
				if (content !== undefined) widgets.push(id);
			},
			notify: (): void => undefined,
		},
		sessionManager: { getBranch: (): unknown[] => [] },
	} as unknown as ExtensionContext;
	const pi = {
		events: {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			const group = listeners.get(event) ?? [];
			group.push(handler);
			listeners.set(event, group);
			return (): void => undefined;
		},
		registerTool: (): void => undefined,
		registerCommand: (): void => undefined,
		registerShortcut: (
			name: string,
			options: { handler: (ctx: unknown) => Promise<void> },
		): void => {
			shortcuts.set(name, async () => await options.handler(context));
		},
		appendEntry: (): void => undefined,
		sendMessage: (): void => undefined,
		exec: async (): Promise<{ stdout: string; stderr: string; code: number }> => ({
			stdout: "",
			stderr: "",
			code: 0,
		}),
		getAllTools: (): readonly unknown[] => [],
		getActiveTools: (): readonly string[] => [],
		setActiveTools: (): void => undefined,
	} as unknown as ExtensionAPI;
	return {
		pi,
		context,
		widgets,
		fire: async (event: string): Promise<void> => {
			for (const handler of listeners.get(event) ?? []) await handler({}, context);
		},
		pressActivityShortcut: async (): Promise<void> => {
			const handler = shortcuts.get("ctrl+shift+w");
			if (handler === undefined) throw new Error("activity shortcut was not registered");
			await handler();
		},
	};
}

describe("web activity widget", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		activityMonitor.clear();
		vi.useRealTimers();
	});

	test("collapses a burst of activity events into few widget paints", async (): Promise<void> => {
		const current = host();
		webAccessExtension(current.pi);
		await current.fire("session_start");
		await current.pressActivityShortcut();
		const before = current.widgets.length;
		for (let index = 0; index < 60; index += 1) {
			const id = activityMonitor.logStart({ type: "api", query: `query ${index}` });
			activityMonitor.logComplete(id, 200);
		}
		// 120 events used to rebuild the whole widget body each time. The widget now follows the
		// shared streaming window: the first event paints, the rest collapse into trailing paints.
		expect(current.widgets.length - before).toBeLessThan(6);
		await current.fire("session_shutdown");
	});
});
