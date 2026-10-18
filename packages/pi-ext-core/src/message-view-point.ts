import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	createExtensionPointKey,
	type ExtensionPointKey,
	readExtensionHooks,
} from "./extension-point.js";
import type { RuntimeHost } from "./runtime-identity.js";

export type MessageTone = "dim" | "muted" | "text" | "accent" | "success" | "warning" | "error";

/** Caller-owned rows. A component is rendered into the message column. */
export type MessageRows = string | readonly string[] | Component;

export interface MessageViewHeader {
	readonly kind: string;
	readonly summary?: string | undefined;
	readonly tone?: MessageTone | undefined;
}

/**
 * What a transcript notice asks the optional UI to draw.
 * The drawing rules live in `pi-ext-ui`. This spec is only the request.
 */
export interface MessageViewSpec {
	readonly theme: Theme;
	readonly header: MessageViewHeader;
	readonly preview?: MessageRows | undefined;
	readonly body?: MessageRows | undefined;
	readonly stateHolder?: object | undefined;
	readonly outputPad?: number | undefined;
	readonly defaultExpanded?: boolean | undefined;
	/** Host ctrl+o. Forces the body open without forgetting a local collapse. */
	readonly forcedExpanded?: boolean | undefined;
	readonly invalidate?: (() => void) | undefined;
}

/** Installed by `pi-ext-ui`. Absent when that package is not loaded. */
export type MessageViewFactory = (spec: MessageViewSpec) => Component;

export const messageViewPoint: ExtensionPointKey<MessageViewFactory> = createExtensionPointKey(
	"@hheei/pi-ext-ui/message-view",
);

/**
 * The first registered factory, or nothing.
 *
 * Consumers must not open this point. It has one provider, and a second owner throws.
 * Call this at render time so a later-loaded `pi-ext-ui` is still visible.
 */
export function readMessageView(pi: object): MessageViewFactory | undefined {
	// A partial extension API may omit `events`. runtimeIdentity then keys the registry by that object.
	return readExtensionHooks(pi as RuntimeHost, messageViewPoint)[0];
}
