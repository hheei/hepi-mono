import { describe, expect, test } from "vitest";
import { convertInputText } from "../src/model.js";
import { buildOptimizerPrompt } from "../src/prompt.js";
import type { OptimizerSettings } from "../src/settings.js";

const off: OptimizerSettings = {
	t2s: { mode: "off" },
	caveman: { level: "off" },
	ponytail: { level: "off" },
	rtk: { enabled: false, path: "" },
};

describe("input and prompt model behavior", () => {
	test("converts prose while retaining inline and fenced code exactly", () => {
		expect(convertInputText("甚麼設定 `甚麼`\n```ts\n設定\n```\n最後設定")).toBe(
			"什么设定 `甚麼`\n```ts\n設定\n```\n最后设定",
		);
		expect(convertInputText("說明 `繁體\n設定` 結束")).toBe("说明 `繁體\n設定` 结束");
		expect(convertInputText("```text\n```not-a-close\n設定\n```\n最後設定")).toBe(
			"```text\n```not-a-close\n設定\n```\n最后设定",
		);
	});

	test("returns enabled optimizer fragments in fixed order and no fragment while disabled", () => {
		const prompt = buildOptimizerPrompt({
			...off,
			caveman: { level: "micro" },
			ponytail: { level: "full" },
			rtk: { enabled: true, path: "/custom/rtk" },
		});
		expect(prompt).toContain("Token efficiency");
		expect(prompt).toContain("When NOT to be lazy");
		expect(prompt).toContain("eligible local, foreground bash command");
		expect(prompt).not.toContain("/custom/rtk");
		expect(prompt.indexOf("CAVEMAN MODE")).toBeLessThan(prompt.indexOf("PONYTAIL MODE"));
		expect(prompt.indexOf("PONYTAIL MODE")).toBeLessThan(prompt.indexOf("# RTK"));
		expect(buildOptimizerPrompt(off)).toBe("");
	});
});
