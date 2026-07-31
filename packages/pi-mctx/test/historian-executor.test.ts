import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompletionSubagentResult, ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import {
	createMctxHistorianPrompt,
	executeMctxHistorianCompletion,
	MCTX_HISTORIAN_SYSTEM_PROMPT,
} from "../src/historian-executor.js";

const model = { api: "test", provider: "anthropic", id: "historian" } as Model<Api>;
const source = { entryIds: ["entry-1", "entry-2"], fingerprint: "snapshot-1" } as const;

function completed(output: string): CompletionSubagentResult {
	return { id: "test" as never, mode: "completion", status: "completed", output };
}

function failed(reason: string): CompletionSubagentResult {
	return { id: "test" as never, mode: "completion", status: "failed", output: "", failure: reason };
}

test("constructs a JSON-only no-tools historian completion", async (): Promise<void> => {
	const controller = new AbortController();
	const request = { model, source, sourceText: "history", signal: controller.signal };
	let received: unknown;
	const result = await executeMctxHistorianCompletion(
		{} as ExtensionLifecycleContext,
		request,
		(_context, spec) => {
			received = spec;
			return { result: Promise.resolve(completed("{}")), cancel: () => undefined };
		},
	);
	expect(result).toEqual({ kind: "completed", output: "{}" });
	expect(received).toEqual({
		mode: "completion",
		model,
		prompt: createMctxHistorianPrompt(request),
		systemPrompt: MCTX_HISTORIAN_SYSTEM_PROMPT,
		thinkingLevel: "off",
	});
});

test("normalizes failed terminals", async (): Promise<void> => {
	const result = await executeMctxHistorianCompletion(
		{} as ExtensionLifecycleContext,
		{ model, source, sourceText: "history", signal: new AbortController().signal },
		() => ({ result: Promise.resolve(failed("overloaded")), cancel: () => undefined }),
	);
	expect(result).toEqual({ kind: "failed", reason: "overloaded" });
});

test("cancels the core handle when the run signal aborts", async (): Promise<void> => {
	const controller = new AbortController();
	let resolve: (value: CompletionSubagentResult) => void = () => undefined;
	const pending = new Promise<CompletionSubagentResult>((done) => {
		resolve = done;
	});
	let cancelled = 0;
	const running = executeMctxHistorianCompletion(
		{} as ExtensionLifecycleContext,
		{ model, source, sourceText: "history", signal: controller.signal },
		() => ({ result: pending, cancel: () => void cancelled++ }),
	);
	controller.abort();
	resolve({ id: "test" as never, mode: "completion", status: "cancelled", output: "" });
	expect(await running).toEqual({ kind: "cancelled" });
	expect(cancelled).toBe(1);
});
