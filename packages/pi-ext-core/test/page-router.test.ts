import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
	type ExtensionPageRegistration,
	openExtensionPageRouter,
	registerExtensionPage,
} from "../src/index.js";

/** The overlay options Pi hands to `ui.custom`'s second argument. */
interface HostCustomOptions {
	readonly overlay?: boolean;
	readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
	readonly onHandle?: (handle: OverlayHandle) => void;
}

function settle(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

interface MountedSurface {
	readonly component: Component;
	/** Resolves the host's `ui.custom` promise, i.e. closes the mounted page. */
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

/**
 * Builds the fake extension host the page router mounts into.
 *
 * Every test needs the same `ui.custom` scaffolding — the fake theme, the mounted
 * component, the surface resolver — and differs only in what it observes, so
 * `onCustom` receives the mounted surface (with the router's overlay options).
 * `ui` carries extra host members such as `editor`.
 */
function host(
	options: {
		readonly ui?: Record<string, unknown>;
		readonly onCustom?: (surface: MountedSurface, customOptions?: HostCustomOptions) => void;
	} = {},
) {
	const events: string[] = [];
	const pi = { events } as unknown as ExtensionAPI;
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const resources: Array<() => void | Promise<void>> = [];
	let mounted: Component | undefined;
	const command = {
		mode: "tui",
		ui: {
			theme,
			...options.ui,
			custom<T>(
				factory: (
					tui: never,
					theme: never,
					keybindings: never,
					done: (value: T) => void,
				) => Component,
				customOptions?: HostCustomOptions,
			): Promise<T> {
				let resolveSurface: (value: T) => void = () => undefined;
				let rejectSurface: (error: unknown) => void = () => undefined;
				const surface = new Promise<T>((resolve, reject) => {
					resolveSurface = resolve;
					rejectSurface = reject;
				});
				mounted = factory(
					{ requestRender: () => undefined } as never,
					theme as never,
					undefined as never,
					(value: T) => resolveSurface(value),
				);
				options.onCustom?.(
					{
						component: mounted,
						resolve: () => resolveSurface(undefined as T),
						reject: rejectSurface,
					},
					customOptions,
				);
				return surface;
			},
		},
	} as unknown as ExtensionCommandContext;
	const lifecycle = {
		pi,
		extension: command,
		signal: new AbortController().signal,
		resources: {
			add: (_id: string, cleanup: () => void | Promise<void>): void => {
				resources.push(cleanup);
			},
		},
	} as never;
	return { pi, command, theme, events, resources, lifecycle, mounted: () => mounted };
}

test("lets the active page consume Left and only then falls back to tab routing", async () => {
	let consumeLeft = true;
	let finish: (() => void) | undefined;
	const { pi, command, lifecycle, resources, mounted } = host({
		onCustom: (surface) => {
			finish = surface.resolve;
		},
	});
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
	const component = mounted();
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
	let requestClose: (() => void) | undefined;
	const { pi, command, lifecycle, resources, mounted } = host();
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
	if (mounted() === undefined || requestClose === undefined) throw new Error("Expected page view");
	requestClose();
	await opening;
	for (const cleanup of resources) await cleanup();
});

test("acquires host resources only while the custom surface is open", async () => {
	let opens = 0;
	let releaseStarted = 0;
	let releaseFinished = false;
	let closeCalls = 0;
	let finishCreate: (() => void) | undefined;
	let finishClose: (() => void) | undefined;
	let finishRelease: (() => void) | undefined;
	let markReleaseStarted: (() => void) | undefined;
	const releaseDidStart = new Promise<void>((resolve) => {
		markReleaseStarted = resolve;
	});
	let finish: (() => void) | undefined;
	const { pi, command, lifecycle, mounted } = host({
		onCustom: (surface) => {
			finish = surface.resolve;
		},
	});
	registerExtensionPage(lifecycle, {
		id: "page",
		label: "Page",
		order: 0,
		create: () =>
			new Promise((resolve) => {
				finishCreate = () =>
					resolve({
						component: { render: () => ["Page"], invalidate: () => undefined },
						handleInput: () => false,
						close: () =>
							new Promise<void>((resolveClose) => {
								closeCalls++;
								finishClose = resolveClose;
							}),
					});
			}),
	});

	const opening = openExtensionPageRouter(pi, command, {
		hostId: "test-router",
		signal: new AbortController().signal,
		maxPending: 0,
		onSurfaceOpen: () => {
			opens++;
			return () =>
				new Promise<void>((resolve) => {
					releaseStarted++;
					markReleaseStarted?.();
					finishRelease = () => {
						releaseFinished = true;
						resolve();
					};
				});
		},
	});
	await settle();
	expect(opens).toBe(1);
	if (finish === undefined || mounted() === undefined) throw new Error("Expected router component");
	finish();
	await settle();
	expect(finishCreate).toBeDefined();
	expect(closeCalls).toBe(0);
	expect(releaseStarted).toBe(0);
	let openingSettled = false;
	void opening.then(() => {
		openingSettled = true;
	});
	await settle();
	expect(openingSettled).toBe(false);
	if (finishCreate === undefined) throw new Error("Expected page creation callback");
	finishCreate();
	await settle();
	expect(finishClose).toBeDefined();
	expect(closeCalls).toBe(1);
	expect(releaseStarted).toBe(0);
	expect(openingSettled).toBe(false);
	if (finishClose === undefined) throw new Error("Expected view close callback");
	finishClose();
	await releaseDidStart;
	expect(closeCalls).toBe(1);
	expect(releaseStarted).toBe(1);
	expect(releaseFinished).toBe(false);
	expect(openingSettled).toBe(false);
	if (finishRelease === undefined) throw new Error("Expected resource release callback");
	finishRelease();
	await opening;
	expect(releaseFinished).toBe(true);
});

test("keeps a queued router gated until late view cleanup and release finish", async () => {
	const finishSurfaces: Array<() => void> = [];
	let customCalls = 0;
	let createCalls = 0;
	let firstOpens = 0;
	let secondOpens = 0;
	let closeCalls = 0;
	let finishCreate: (() => void) | undefined;
	let finishClose: (() => void) | undefined;
	let finishRelease: (() => void) | undefined;
	let markReleaseStarted: (() => void) | undefined;
	const releaseStarted = new Promise<void>((resolve) => {
		markReleaseStarted = resolve;
	});
	const { pi, command, lifecycle } = host({
		onCustom: (surface) => {
			customCalls++;
			finishSurfaces.push(surface.resolve);
		},
	});
	registerExtensionPage(lifecycle, {
		id: "page",
		label: "Page",
		order: 0,
		create: () => {
			createCalls++;
			if (createCalls > 1)
				return Promise.resolve({
					component: { render: () => ["Page"], invalidate: () => undefined },
					handleInput: () => false,
					close: () => undefined,
				});
			return new Promise((resolve) => {
				finishCreate = () =>
					resolve({
						component: { render: () => ["Page"], invalidate: () => undefined },
						handleInput: () => false,
						close: () =>
							new Promise<void>((resolveClose) => {
								closeCalls++;
								finishClose = resolveClose;
							}),
					});
			});
		},
	});

	const first = openExtensionPageRouter(pi, command, {
		hostId: "queued-router",
		signal: new AbortController().signal,
		maxPending: 1,
		onSurfaceOpen: () => {
			firstOpens++;
			return () =>
				new Promise<void>((resolve) => {
					markReleaseStarted?.();
					finishRelease = resolve;
				});
		},
	});
	const second = openExtensionPageRouter(pi, command, {
		hostId: "queued-router",
		signal: new AbortController().signal,
		maxPending: 1,
		onSurfaceOpen: () => {
			secondOpens++;
			return undefined;
		},
	});

	expect(customCalls).toBe(1);
	expect(firstOpens).toBe(1);
	expect(secondOpens).toBe(0);
	finishSurfaces[0]?.();
	await settle();
	expect(customCalls).toBe(1);
	expect(secondOpens).toBe(0);
	if (finishCreate === undefined) throw new Error("Expected first page creation gate");
	finishCreate();
	await settle();
	expect(closeCalls).toBe(1);
	expect(customCalls).toBe(1);
	expect(secondOpens).toBe(0);
	if (finishClose === undefined) throw new Error("Expected late view close gate");
	finishClose();
	await releaseStarted;
	expect(customCalls).toBe(1);
	expect(secondOpens).toBe(0);
	if (finishRelease === undefined) throw new Error("Expected surface release gate");
	finishRelease();
	await first;
	await settle();
	expect(customCalls).toBe(2);
	expect(secondOpens).toBe(1);
	expect(createCalls).toBe(2);
	finishSurfaces[1]?.();
	await second;
});

test("treats an aborting page creator as normal surface cleanup", async () => {
	let finish: (() => void) | undefined;
	let releases = 0;
	const { pi, command, lifecycle } = host({
		onCustom: (surface) => {
			finish = surface.resolve;
		},
	});
	registerExtensionPage(lifecycle, {
		id: "page",
		label: "Page",
		order: 0,
		create: (context) =>
			new Promise((_resolve, reject) => {
				context.signal.addEventListener(
					"abort",
					() => {
						const error = new Error("page creation aborted");
						error.name = "AbortError";
						reject(error);
					},
					{ once: true },
				);
			}),
	});
	const opening = openExtensionPageRouter(pi, command, {
		hostId: "aborting-page-router",
		signal: new AbortController().signal,
		maxPending: 0,
		onSurfaceOpen: () => () => {
			releases++;
		},
	});
	await settle();
	if (finish === undefined) throw new Error("Expected router close callback");
	finish();
	await expect(opening).resolves.toBeUndefined();
	expect(releases).toBe(1);
});

test("awaits a removed page view cleanup before releasing surface resources", async () => {
	let finishClose: (() => void) | undefined;
	let releases = 0;
	const { pi, command, lifecycle, resources } = host();
	registerExtensionPage(lifecycle, {
		id: "page",
		label: "Page",
		order: 0,
		create: async () => ({
			component: { render: () => ["Page"], invalidate: () => undefined },
			handleInput: () => false,
			close: () =>
				new Promise<void>((resolve) => {
					finishClose = resolve;
				}),
		}),
	});
	const opening = openExtensionPageRouter(pi, command, {
		hostId: "removed-page-router",
		signal: new AbortController().signal,
		maxPending: 0,
		onSurfaceOpen: () => () => {
			releases++;
		},
	});
	await settle();
	const unregister = resources[0];
	if (unregister === undefined) throw new Error("Expected page registration cleanup");
	await unregister();
	await settle();
	expect(finishClose).toBeDefined();
	expect(releases).toBe(0);
	let openingSettled = false;
	void opening.then(() => {
		openingSettled = true;
	});
	await settle();
	expect(openingSettled).toBe(false);
	if (finishClose === undefined) throw new Error("Expected removed view close callback");
	finishClose();
	await opening;
	expect(releases).toBe(1);
});

test("awaits cleanup and preserves both failures when an opened surface rejects", async () => {
	let rejectSurface: ((error: Error) => void) | undefined;
	let closeCalls = 0;
	let releaseCalls = 0;
	const { pi, command, lifecycle } = host({
		onCustom: (surface) => {
			rejectSurface = surface.reject;
		},
	});
	registerExtensionPage(lifecycle, {
		id: "page",
		label: "Page",
		order: 0,
		create: async () => ({
			component: { render: () => ["Page"], invalidate: () => undefined },
			handleInput: () => false,
			close: () => {
				closeCalls++;
				throw new Error("cleanup failed");
			},
		}),
	});
	const opening = openExtensionPageRouter(pi, command, {
		hostId: "rejecting-router",
		signal: new AbortController().signal,
		maxPending: 0,
		onSurfaceOpen: () => () => {
			releaseCalls++;
		},
	});
	await settle();
	if (rejectSurface === undefined) throw new Error("Expected opened surface rejection hook");
	rejectSurface(new Error("surface failed"));
	try {
		await opening;
		throw new Error("Expected router failure");
	} catch (error: unknown) {
		if (!(error instanceof AggregateError)) throw error;
		expect(error.message).toBe("TUI surface host and before-release hook both failed");
		expect(error.errors).toHaveLength(2);
		expect(error.errors[0]).toEqual(new Error("surface failed"));
		expect(error.errors[1]).toBeInstanceOf(AggregateError);
	}
	expect(closeCalls).toBe(1);
	expect(releaseCalls).toBe(1);
});

test("forwards overlay options and delegates page editors through the hidden overlay", async () => {
	const events: string[] = [];
	let hidden = false;
	const handle: OverlayHandle = {
		hide: () => undefined,
		setHidden: (value) => {
			hidden = value;
			events.push(value ? "hide" : "show");
		},
		isHidden: () => hidden,
		focus: () => undefined,
		unfocus: () => undefined,
		isFocused: () => !hidden,
		getBounds: () => undefined,
	};
	let finish: (() => void) | undefined;
	let openEditor: ((title: string, prefill?: string) => Promise<string | undefined>) | undefined;
	let customOptions: HostCustomOptions | undefined;
	const { pi, command, lifecycle, resources } = host({
		ui: {
			editor: async (title: string, prefill?: string): Promise<string | undefined> => {
				events.push(`editor:${title}:${prefill ?? ""}`);
				return undefined;
			},
		},
		onCustom: (surface, options) => {
			finish = surface.resolve;
			customOptions = options;
			options?.onHandle?.(handle);
		},
	});
	registerExtensionPage(lifecycle, {
		id: "page",
		label: "Page",
		order: 0,
		create: async (context) => {
			openEditor = context.openEditor;
			return {
				component: { render: () => ["Page"], invalidate: () => undefined },
				handleInput: () => false,
				close: () => undefined,
			};
		},
	});
	const overlayOptions: OverlayOptions = { anchor: "bottom-left", width: "100%" };
	const opening = openExtensionPageRouter(pi, command, {
		hostId: "overlay-router",
		signal: new AbortController().signal,
		maxPending: 0,
		overlay: true,
		overlayOptions,
	});
	await settle();
	if (customOptions === undefined || openEditor === undefined || finish === undefined)
		throw new Error("Expected overlay router");
	const forwardedOptions = customOptions;
	const invokeEditor = openEditor;
	const closeRouter = finish;
	expect(forwardedOptions.overlay).toBe(true);
	expect(forwardedOptions.overlayOptions).toBe(overlayOptions);
	await expect(invokeEditor("Body", "prefill")).resolves.toBeUndefined();
	expect(events).toEqual(["hide", "editor:Body:prefill", "show"]);
	closeRouter();
	await opening;
	for (const cleanup of resources) await cleanup();
});
