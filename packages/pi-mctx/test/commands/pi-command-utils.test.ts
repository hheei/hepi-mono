import { describe, expect, it } from "vitest";

import {
	CTX_STATUS_CUSTOM_TYPE,
	registerCtxStatusEntryRenderer,
	sendCtxStatusMessage,
} from "../../src/commands/pi-command-utils";

describe("ctx-status entries", () => {
	it("appends model-invisible entry data instead of sending a message", () => {
		const appended: Array<{ customType: string; data: unknown }> = [];
		const pi = {
			registerEntryRenderer() {},
			appendEntry(customType: string, data?: unknown) {
				appended.push({ customType, data });
			},
		};

		registerCtxStatusEntryRenderer(pi);
		sendCtxStatusMessage(
			pi,
			{ title: "Magic Embed", text: "Embedding history…", level: "info" },
			{ completed: 2 },
		);

		expect(appended).toEqual([
			{
				customType: CTX_STATUS_CUSTOM_TYPE,
				data: {
					title: "Magic Embed",
					text: "Embedding history…",
					level: "info",
					details: { completed: 2 },
				},
			},
		]);
	});

	it("registers one renderer and ignores malformed data", () => {
		let customType = "";
		let renderer: unknown;
		const pi = {
			registerEntryRenderer(type: string, value: unknown) {
				customType = type;
				renderer = value;
			},
			appendEntry() {},
		};

		expect(registerCtxStatusEntryRenderer(pi)).toBe(true);
		expect(customType).toBe(CTX_STATUS_CUSTOM_TYPE);
		expect(renderer).toBeDefined();
	});
});
