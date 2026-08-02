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
			...(id === "a" ? { minRows: 20 } : {}),
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
	const initialRender = component.render(80);
	expect(initialRender.join("\n")).toContain("A");
	expect(initialRender).toHaveLength(24);
	consumeLeft = false;
	component.handleInput("\x1b[C");
	await settle();
	expect(component.render(80).join("\n")).toContain("B");
	if (finish === undefined) throw new Error("Expected router close callback");
	finish();
	await opening;
	for (const cleanup of resources) await cleanup();
});

test("lets a page close the host after its own asynchronous work", async () => {
	const events = {};
	const pi = { events } as unknown as ExtensionAPI;
	let component: Component | undefined;
	let finish: (() => void) | undefined;
	let requestClose: (() => void) | undefined;
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
					() => finish?.(),
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
	registerExtensionPage(lifecycle, {
		id: "page",
		label: "Page",
		order: 0,
		create: async (context) => {
			requestClose = context.requestClose;
			return {
				component: { render: () => ["Page"], invalidate: () => undefined },
				handleInput: () => false,
				close: () => undefined,
			};
		},
	});

	const opening = openExtensionPageRouter(pi, command, {
		hostId: "test-router",
		signal: new AbortController().signal,
		maxPending: 0,
	});
	await settle();
	if (component === undefined || requestClose === undefined) throw new Error("Expected page view");
	requestClose();
	await opening;
	for (const cleanup of resources) await cleanup();
});

test("acquires host resources only while the custom surface is open", async () => {
	const events = {};
	const pi = { events } as unknown as ExtensionAPI;
	let component: Component | undefined;
	let finish: (() => void) | undefined;
	let opens = 0;
	let releases = 0;
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
					() => finish?.(),
				);
				return new Promise<T>((resolve) => {
					finish = () => resolve(undefined as T);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const lifecycle = {
		pi,
		extension: command,
		signal: new AbortController().signal,
		resources: { add: () => undefined },
	} as never;
	registerExtensionPage(lifecycle, {
		id: "page",
		label: "Page",
		order: 0,
		create: async () => ({
			component: { render: () => ["Page"], invalidate: () => undefined },
			handleInput: () => false,
			close: () => undefined,
		}),
	});

	const opening = openExtensionPageRouter(pi, command, {
		hostId: "test-router",
		signal: new AbortController().signal,
		maxPending: 0,
		onSurfaceOpen: () => {
			opens++;
			return () => releases++;
		},
	});
	await settle();
	expect(opens).toBe(1);
	if (finish === undefined || component === undefined) throw new Error("Expected router component");
	finish();
	await opening;
	await settle();
	expect(releases).toBe(1);
});
