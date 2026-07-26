import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HePiRegistry } from "./registry.js";

export interface HePiRuntimeContext {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly registry: HePiRegistry;
	readonly requestRender: () => void;
	readonly close: () => void;
}

export interface HePiRuntimeContextOptions {
	readonly requestRender?: () => void;
	readonly close?: () => void;
}

export function createHePiRuntimeContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	registry: HePiRegistry,
	options: HePiRuntimeContextOptions = {},
): HePiRuntimeContext {
	return {
		pi,
		ctx,
		registry,
		requestRender: options.requestRender ?? (() => undefined),
		close: options.close ?? (() => undefined),
	};
}
