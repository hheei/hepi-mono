import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHepiWidget, suspendHepiWidgets } from "../src/index.js";

function fixture(): {
	readonly pi: ExtensionAPI;
	readonly extension: ExtensionContext;
	readonly calls: Array<{
		readonly key: string;
		readonly content: unknown;
		readonly placement: string;
	}>;
} {
	const calls: Array<{
		readonly key: string;
		readonly content: unknown;
		readonly placement: string;
	}> = [];
	return {
		pi: { events: {} } as unknown as ExtensionAPI,
		extension: {
			mode: "tui",
			ui: {
				setWidget: (key: string, content: unknown, options: { readonly placement: string }) =>
					calls.push({ key, content, placement: options.placement }),
			},
		} as unknown as ExtensionContext,
		calls,
	};
}

test("suspends all managed widgets until the final Settings lease releases", () => {
	const h = fixture();
	const controller = new AbortController();
	const handle = registerHepiWidget(h.pi, h.extension, controller.signal, {
		id: "test:widget",
		placement: "aboveEditor",
		create: () => ({ render: () => ["widget"], invalidate: () => undefined }),
	});
	expect(typeof h.calls.at(-1)?.content).toBe("function");
	const first = suspendHepiWidgets(h.pi);
	const second = suspendHepiWidgets(h.pi);
	expect(h.calls.at(-1)?.content).toBeUndefined();
	first.release();
	expect(h.calls.at(-1)?.content).toBeUndefined();
	second.release();
	expect(typeof h.calls.at(-1)?.content).toBe("function");
	handle.dispose();
	expect(h.calls.at(-1)?.content).toBeUndefined();
});

test("removes a managed widget when its lifecycle signal aborts", () => {
	const h = fixture();
	const controller = new AbortController();
	registerHepiWidget(h.pi, h.extension, controller.signal, {
		id: "test:widget",
		placement: "belowEditor",
		create: () => ({ render: () => ["widget"], invalidate: () => undefined }),
	});
	controller.abort();
	expect(h.calls.at(-1)).toEqual({
		key: "test:widget",
		content: undefined,
		placement: "belowEditor",
	});
});
