import { describe, expect, test } from "bun:test";
import { createSessionStorage } from "../../../src/api/settings.js";
import { createSettingsController } from "../../../src/modules/setting/controller.js";
import { createSettingsFixture } from "../../fixtures/settings.js";
import { fakeStorage, testContext } from "../../helpers.js";

describe("settings controller", () => {
	test("loads defaults and orders callbacks before save", async () => {
		const events: string[] = [];
		const storage = fakeStorage();
		const provider = createSettingsFixture({
			storage,
			onLoad: async () => {
				events.push("load");
			},
			onChange: async () => {
				events.push("change");
			},
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		await controller.toggle();
		events.push("after");
		expect(events).toEqual(["load", "change", "after"]);
		expect(storage.saves).toHaveLength(1);
	});
	test("serializes provider saves in change order", async () => {
		const events: string[] = [];
		const gate = Promise.withResolvers<void>();
		const provider = createSettingsFixture({
			onChange: async (change) => {
				events.push(String(change.value));
				if (change.value === false) await gate.promise;
			},
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		const first = controller.change(false);
		await Promise.resolve();
		const second = controller.change(true);
		expect(events).toEqual(["false"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["false", "true"]);
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
	test("rolls back failed save and retains error", async () => {
		const provider = createSettingsFixture({
			storage: fakeStorage({ failSave: new Error("nope") }),
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		await expect(controller.toggle()).rejects.toThrow("nope");
		expect(controller.state.committed.fixture!.general!.enabled).toBe(true);
		expect(controller.state.error).toBe("nope");
	});
	test("reconciles sequential failures against committed state", async () => {
		const provider = createSettingsFixture({
			storage: fakeStorage({ failSave: new Error("nope") }),
		});
		const controller = createSettingsController({ providers: [provider], context: testContext() });
		await controller.load();
		controller.select("enabled");
		controller.beginEdit();
		controller.setDraft("keep draft");
		const first = controller.change(false, "enabled");
		const second = controller.change(true, "enabled");
		const results = await Promise.allSettled([first, second]);
		expect(results.every((result) => result.status === "rejected")).toBe(true);
		expect(controller.state.committed.fixture!.general!.enabled).toBe(true);
		expect(controller.state.mode).toBe("Edit");
		expect(controller.state.draftValue).toBe("keep draft");
		expect(controller.state.selection?.itemId).toBe("enabled");
		expect(controller.state.error).toBe("nope");
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

	test("attempts every cleanup and closes storage after onClose", async () => {
		const events: string[] = [];
		const firstStorage = {
			...fakeStorage(),
			close: async () => {
				events.push("first:storage");
			},
		};
		const secondStorage = {
			...fakeStorage(),
			close: async () => {
				events.push("second:storage");
				throw new Error("storage failed");
			},
		};
		const first = createSettingsFixture({
			id: "first",
			storage: firstStorage,
			onClose: async () => {
				events.push("first:onClose");
				throw new Error("callback failed");
			},
		});
		const second = createSettingsFixture({
			id: "second",
			storage: secondStorage,
			onClose: async () => {
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
