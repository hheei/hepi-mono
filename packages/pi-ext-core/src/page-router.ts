import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionLifecycleContext } from "./lifecycle.js";

/**
 * Context created for one lazily constructed page view. Page state is local to a
 * single open router surface and must be released when the supplied signal aborts.
 */
export interface ExtensionPageViewContext {
	readonly command: ExtensionCommandContext;
	readonly signal: AbortSignal;
	readonly theme: Theme;
	requestRender(): void;
}

/**
 * A contributor-owned component and its cleanup for one open router surface.
 *
 * `handleInput` returns whether the page consumed the key. The router invokes it
 * before interpreting Left/Right as tab navigation. `onThemeChange` must rebuild
 * cached theme-dependent content before it requests the next render.
 */
export interface ExtensionPageView {
	readonly component: Component;
	handleInput(input: string): boolean | Promise<boolean>;
	onThemeChange?(theme: Theme): void;
	close(): void | Promise<void>;
}

/**
 * One lifecycle-bound tab in the global Extension page router.
 *
 * Smaller order values render first; equal values use the stable ID as a
 * deterministic tie-break. The router calls create lazily and gives the active
 * page first opportunity to handle Left/Right before switching tabs itself.
 */
export interface ExtensionPageRegistration {
	readonly id: string;
	readonly label: string;
	readonly order: number;
	create(context: ExtensionPageViewContext): Promise<ExtensionPageView>;
}

export interface OpenExtensionPageRouterOptions {
	readonly initialPageId?: string;
}

/** Registers a page for this lifecycle; the router removes it during cleanup. */
export function registerExtensionPage(
	_context: ExtensionLifecycleContext,
	_registration: ExtensionPageRegistration,
): void {
	throw new Error("@hheei/pi-ext-core Extension page router is not implemented");
}

/** Opens the global page router from the single Settings host command. */
export function openExtensionPageRouter(
	_context: ExtensionCommandContext,
	_options: OpenExtensionPageRouterOptions = {},
): Promise<void> {
	throw new Error("@hheei/pi-ext-core Extension page router is not implemented");
}
