import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	type ExtensionPageRegistration,
	openExtensionPageRouter,
	registerExtensionPage,
} from "../src/index.js";

function settle(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

test("lets the active page consume Left and only then falls back to tab routing", async () => {
	const events = {};
	const pi = { events } as unknown as ExtensionAPI;
	let component: Component | undefined;
	let finish: (() => void) | undefined;
	let consumeLeft = true;
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const command = {
		mode: "tui",
		ui: {
			theme,
			custom<T>(
				factory: (
					tui: never,
					theme: never,
					keybindings: never,
					done: (value: T) => void,
				) => Component,
			): Promise<T> {
				component = factory(
					{ requestRender: () => undefined } as never,
					theme as never,
					undefined as never,
					() => {
						finish?.();
					},
				);
				return new Promise<T>((resolve) => {
					finish = () => resolve(undefined as T);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const resources: Array<() => void | Promise<void>> = [];
	const lifecycle = {
		pi,
		extension: command,
		signal: new AbortController().signal,
		resources: {
			add: (_id: string, cleanup: () => void | Promise<void>) => resources.push(cleanup),
		},
	} as never;
	const page = (id: string, label: string): ExtensionPageRegistration => ({
		id,
		label,
		order: id === "a" ? 0 : 1,
		create: async () => ({
			component: { render: () => [label], invalidate: () => undefined },
			handleInput: (input) => input === "\x1b[D" && consumeLeft,
			close: () => undefined,
		}),
	});
	registerExtensionPage(lifecycle, page("a", "A"));
	registerExtensionPage(lifecycle, page("b", "B"));

	const opening = openExtensionPageRouter(pi, command, {
		hostId: "test-router",
		signal: new AbortController().signal,
		maxPending: 0,
	});
	await settle();
	if (component?.handleInput === undefined) throw new Error("Expected router component");
	component.handleInput("\x1b[D");
	await settle();
	expect(component.render(80).join("\n")).toContain("A");
	consumeLeft = false;
	component.handleInput("\x1b[C");
	await settle();
	expect(component.render(80).join("\n")).toContain("B");
	if (finish === undefined) throw new Error("Expected router close callback");
	finish();
	await opening;
	for (const cleanup of resources) await cleanup();
});
