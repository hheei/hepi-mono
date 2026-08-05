import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HepiRuntimeContext } from "../../src/core/runtime/context.js";
import { createRetryFeature, parseRetryStallTimeoutMs } from "../../src/retry/feature.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness(): {
	readonly feature: ReturnType<typeof createRetryFeature>;
	readonly ctx: ExtensionContext;
	readonly handlers: Map<string, Handler>;
	readonly statusUpdates: Array<[string, string | undefined]>;
} {
	const handlers = new Map<string, Handler>();
	const statusUpdates: Array<[string, string | undefined]> = [];
	const pi = {
		registerFlag(_name: string, _options: unknown): void {},
		getFlag(_name: string): undefined {
			return undefined;
		},
		on(event: string, handler: Handler): void {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		isIdle: () => false,
		abort: () => undefined,
		ui: {
			setStatus: (key: string, value: string | undefined) => statusUpdates.push([key, value]),
			notify: () => undefined,
		},
		sessionManager: { getSessionId: () => "retry-test" },
	} as unknown as ExtensionContext;
	const feature = createRetryFeature(pi, () => true);
	feature.start({ ctx } as HepiRuntimeContext);
	return { feature, ctx, handlers, statusUpdates };
}

test("parses retry stall timeout values", () => {
	expect(parseRetryStallTimeoutMs(undefined)).toBeUndefined();
	expect(parseRetryStallTimeoutMs("off")).toBe(0);
	expect(parseRetryStallTimeoutMs("12.8")).toBe(12);
	expect(parseRetryStallTimeoutMs("-1")).toBeUndefined();
});

test("adds Pi retry hint once for known provider errors and clears status on cleanup", () => {
	const { ctx, feature, handlers, statusUpdates } = harness();
	const handler = handlers.get("message_end");
	expect(handler).toBeDefined();
	const result = handler!(
		{
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Unknown error (no error details in response)",
			},
		},
		ctx,
	);
	expect(result).toEqual({
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage:
				"Unknown error (no error details in response)\n\n[unknown-error-retry] provider returned error; treating empty-detail provider failure as retryable.",
		},
	});
	const retryMessage = (result as { message: unknown }).message;
	expect(handler!({ message: retryMessage }, ctx)).toBeUndefined();
	feature.dispose(ctx);
	expect(statusUpdates.at(-1)).toEqual(["retry", undefined]);
});
