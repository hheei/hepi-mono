import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry } from "@hheei/pi-ext-core";
import piPonytailExtension, { PONYTAIL_SETTINGS_PROVIDER_ID } from "../../src/index.js";

type Handler = (event: unknown, context: ExtensionContext) => unknown;

const handlers = new Map<string, Handler[]>();

afterEach(() => handlers.clear());

function createHarness(): {
	pi: ExtensionAPI;
	context: ExtensionContext;
	emit: (event: string) => Promise<void>;
} {
	const pi = {
		events: createEventBus(),
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerCommand() {},
		appendEntry() {},
		getSessionName: () => undefined,
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const context = {
		cwd: process.cwd(),
		sessionManager: { getBranch: () => [] },
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	return {
		pi,
		context,
		emit: async (event) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context);
		},
	};
}

describe("Ponytail lifecycle", () => {
	test("keeps reload handlers from registering settings twice", async () => {
		const harness = createHarness();
		const settingsFilePath = `${import.meta.dir}/reload-settings.json`;
		await Bun.write(settingsFilePath, "{}\n");
		try {
			piPonytailExtension(harness.pi, { settingsFilePath });
			await harness.emit("session_start");
			piPonytailExtension(harness.pi, { settingsFilePath });
			await harness.emit("session_start");
			expect(
				getHepiRuntimeSettingsRegistry(harness.pi).get(PONYTAIL_SETTINGS_PROVIDER_ID),
			).toBeDefined();
			await harness.emit("session_shutdown");
			expect(
				getHepiRuntimeSettingsRegistry(harness.pi).get(PONYTAIL_SETTINGS_PROVIDER_ID),
			).toBeUndefined();
		} finally {
			await rm(settingsFilePath, { force: true });
		}
	});
});
