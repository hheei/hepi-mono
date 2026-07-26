import { describe, expect, test } from "bun:test";
import { createSessionStorage } from "../../../src/core/api/settings.js";
import { createSettingsController } from "../../../src/core/ui/settings/controller.js";
import { createSettingsFixture } from "../../fixtures/settings.js";
import { fakeStorage, testContext } from "../../helpers.js";

describe("settings controller", () => {
	test("blocks changes until asynchronous settings load completes", async () => {
		const gate = Promise.withResolvers<void>();
		const provider = createSettingsFixture({
			storage: {
				load: async () => {
					await gate.promise;
					return undefined;
				},
				save: async () => undefined,
			},
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		const loading = controller.load();
		expect(controller.loading).toBe(true);
		controller.select("enabled");
		await expect(controller.toggle()).rejects.toThrow("still loading");
		gate.resolve();
		await loading;
		expect(controller.loading).toBe(false);
		await controller.toggle();
		expect(controller.state.committed.fixture!.general!.enabled).toBe(false);
		await controller.close();
	});

	test("defers callbacks and one provider save until close", async () => {
		const events: string[] = [];
		const storage = fakeStorage();
		const provider = createSettingsFixture({
			storage,
			onLoad: async () => {
				events.push("load");
			},
			onChange: async (change) => {
				events.push(`change:${change.fieldId}:${String(change.value)}`);
			},
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		await controller.toggle();
		await controller.change("manual", "mode");
		expect(events).toEqual(["load"]);
		expect(storage.saves).toHaveLength(0);
		await controller.close();
		expect(events).toEqual(["load", "change:enabled:false", "change:mode:manual"]);
		expect(storage.saves).toHaveLength(1);
		expect(storage.saves[0]?.general).toMatchObject({ enabled: false, mode: "manual" });
	});
	test("saves providers sequentially to protect shared settings files", async () => {
		let firstSaveActive = false;
		let overlapped = false;
		const first = createSettingsFixture({
			id: "first",
			title: "First",
			storage: {
				load: () => undefined,
				save: async () => {
					firstSaveActive = true;
					await Bun.sleep(10);
					firstSaveActive = false;
				},
			},
		});
		const second = createSettingsFixture({
			id: "second",
			title: "Second",
			storage: {
				load: () => undefined,
				save: () => {
					overlapped = firstSaveActive;
				},
			},
		});
		const controller = createSettingsController({
			providers: [first, second],
			context: testContext(),
		});
		await controller.load();
		controller.selectProvider("first");
		controller.select("enabled");
		await controller.change(false);
		controller.selectProvider("second");
		controller.select("enabled");
		await controller.change(false);
		await controller.close();
		expect(overlapped).toBe(false);
	});

	test("does not save when edits return to the loaded state", async () => {
		const storage = fakeStorage();
		const provider = createSettingsFixture({ storage });
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		await controller.change(false);
		await controller.change(true);
		await controller.close();
		expect(storage.saves).toHaveLength(0);
	});
	test("keeps draft and committed value on parse failure", async () => {
		const provider = createSettingsFixture();
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("mode");
		controller.beginEdit();
		controller.setDraft("bad");
		await expect(controller.commitEdit()).rejects.toThrow("invalid mode");
		expect(controller.state.mode).toBe("Edit");
		expect(controller.state.draftValue).toBe("bad");
		expect(controller.state.committed.fixture!.general!.mode).toBe("auto");
	});
	test("retries a deferred save after close fails", async () => {
		let attempts = 0;
		const provider = createSettingsFixture({
			storage: {
				load: () => undefined,
				save: () => {
					attempts++;
					if (attempts === 1) throw new Error("nope");
				},
			},
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		await controller.toggle();
		expect(controller.state.committed.fixture!.general!.enabled).toBe(false);
		await expect(controller.close({ retryOnFailure: true })).rejects.toThrow(
			"Settings cleanup failed",
		);
		expect(controller.state.error).toBe("nope");
		await expect(controller.close({ retryOnFailure: true })).resolves.toBeUndefined();
		expect(attempts).toBe(2);
	});

	test("runs provider cleanup after a permanent save failure", async () => {
		const events: string[] = [];
		const provider = createSettingsFixture({
			storage: {
				load: () => undefined,
				save: () => {
					throw new Error("save failed");
				},
				close: () => {
					events.push("storage:close");
				},
			},
			onClose: () => {
				events.push("provider:close");
			},
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		await controller.toggle();

		await expect(controller.close()).rejects.toThrow("Settings cleanup failed");
		expect(events).toEqual(["provider:close", "storage:close"]);
	});

	test("retains session storage values across controller close and reopen", async () => {
		const storage = createSessionStorage();
		const provider = createSettingsFixture({ storage });
		const first = createSettingsController({ providers: [provider], context: testContext() });
		await first.load();
		first.select("enabled");
		await first.toggle();
		await first.close();

		const second = createSettingsController({ providers: [provider], context: testContext() });
		await second.load();
		expect(second.state.committed.fixture!.general!.enabled).toBe(false);
		await second.close();
	});

	test("flushes queued saves before closing", async () => {
		let saved = false;
		const storage = {
			async load() {
				return undefined;
			},
			async save() {
				saved = true;
			},
		};
		const provider = createSettingsFixture({ storage });
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		const change = controller.toggle();
		const closing = controller.close();
		await Promise.allSettled([change, closing]);
		expect(saved).toBe(true);
	});

	test("forced close waits for an active retryable save", async () => {
		const save = Promise.withResolvers<void>();
		const events: string[] = [];
		const provider = createSettingsFixture({
			storage: {
				load: () => undefined,
				save: () => save.promise,
				close: () => {
					events.push("storage:close");
				},
			},
			onClose: () => {
				events.push("provider:close");
			},
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		await controller.toggle();
		const retryable = controller.close({ retryOnFailure: true });
		let forcedSettled = false;
		const forced = controller.close().finally(() => {
			forcedSettled = true;
		});
		await Bun.sleep(0);
		expect(forcedSettled).toBe(false);

		save.resolve();
		await Promise.all([retryable, forced]);
		expect(events).toEqual(["provider:close", "storage:close"]);
	});

	test("attempts every synchronous cleanup and closes storage after onClose", async () => {
		const events: string[] = [];
		const firstStorage = {
			...fakeStorage(),
			close: () => {
				events.push("first:storage");
			},
		};
		const secondStorage = {
			...fakeStorage(),
			close: () => {
				events.push("second:storage");
				throw new Error("storage failed");
			},
		};
		const first = createSettingsFixture({
			id: "first",
			storage: firstStorage,
			onClose: () => {
				events.push("first:onClose");
				throw new Error("callback failed");
			},
		});
		const second = createSettingsFixture({
			id: "second",
			storage: secondStorage,
			onClose: () => {
				events.push("second:onClose");
			},
		});
		const controller = createSettingsController({
			providers: [first, second],
			context: testContext(),
		});
		await controller.load();

		let error: unknown;
		try {
			await controller.close();
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toHaveLength(2);
		expect(events).toEqual(["first:onClose", "second:onClose", "first:storage", "second:storage"]);
	});
});
