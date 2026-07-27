import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HepiRegistry } from "./registry.js";

export interface HepiRuntimeContext {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly registry: HepiRegistry;
	readonly requestRender: () => void;
	readonly close: () => void;
}

export interface HepiRuntimeContextOptions {
	readonly requestRender?: () => void;
	readonly close?: () => void;
}

export function createHepiRuntimeContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	registry: HepiRegistry,
	options: HepiRuntimeContextOptions = {},
): HepiRuntimeContext {
	return {
		pi,
		ctx,
		registry,
		requestRender: options.requestRender ?? (() => undefined),
		close: options.close ?? (() => undefined),
	};
}
