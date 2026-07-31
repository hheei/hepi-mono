import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../src/register-commands.js";

describe("FFF commands", () => {
	test("registers status and reindex commands without a feature toggle command", () => {
		const names: string[] = [];
		registerCommands(
			{
				registerCommand(name: string) {
					names.push(name);
				},
			} as unknown as ExtensionAPI,
			{ getRuntime: () => null },
		);
		expect(names).toEqual(["reindex-fff", "fff-status"]);
	});
});
