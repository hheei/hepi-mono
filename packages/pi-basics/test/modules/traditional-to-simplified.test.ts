import { describe, expect, test } from "bun:test";
import {
	convertInputText,
	createTraditionalToSimplifiedSettingsProvider,
} from "../../src/modules/traditional-to-simplified/index.js";

describe("traditional to simplified", () => {
	test("converts prose and the missing 甚麼 term", () => {
		expect(convertInputText("甚麼設定需要幫忙？")).toBe("什么设定需要帮忙？");
	});

	test("preserves inline and fenced code", () => {
		const input = "請看 `甚麼`\n```ts\n甚麼設定\n```\n最後設定";
		expect(convertInputText(input)).toBe("请看 `甚麼`\n```ts\n甚麼設定\n```\n最后设定");
	});

	test("persists the toggle without discarding other settings", async () => {
		const path = `${process.env.TMPDIR ?? "/tmp"}/pi-basics-traditional-to-simplified-${Date.now()}.json`;
		const provider = createTraditionalToSimplifiedSettingsProvider();
		await provider.storage.save(
			{ "traditional-to-simplified": { enabled: false } },
			{ sessionId: "test", cwd: path.replace(/\/[^/]+$/, "") },
		);
		const loaded = await provider.storage.load({
			sessionId: "test",
			cwd: path.replace(/\/[^/]+$/, ""),
		});
		expect(loaded?.["traditional-to-simplified"]?.enabled).toBe(false);
	});
});
