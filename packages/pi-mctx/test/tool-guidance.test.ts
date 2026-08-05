import { expect, test } from "bun:test";
import { injectMctxToolGuidance, MCTX_TOOL_GUIDANCE } from "../src/tool-guidance.js";

test("injects one stable model-visible ctx_reduce policy message", (): void => {
	const messages = [{ role: "user" as const, content: "request", timestamp: 1 }];
	const guided = injectMctxToolGuidance(messages);
	expect(guided).toEqual([
		{
			role: "custom",
			customType: "pi-mctx:tool-guidance",
			content: MCTX_TOOL_GUIDANCE,
			display: false,
			timestamp: 0,
		},
		...messages,
	]);
	expect(injectMctxToolGuidance(guided)).toBe(guided);
});
