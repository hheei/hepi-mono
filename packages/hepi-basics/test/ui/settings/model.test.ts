import { describe, expect, test } from "bun:test";
import {
	createSettingsModel,
	cycleOption,
	fieldForSelection,
	mergeSettingsState,
	settingFieldItemId,
	visibleFields,
} from "../../../src/core/ui/settings/model.js";
import { createSettingsFixture } from "../../fixtures/settings.js";

describe("settings model", () => {
	test("merges defaults while preserving unknown stored data", () => {
		const provider = createSettingsFixture();
		expect(
			mergeSettingsState(provider, { general: { enabled: false, unknown: "kept" } }),
		).toMatchObject({
			general: { enabled: false, unknown: "kept", mode: "auto" },
			advanced: { mode: "auto" },
		});
	});
	test("recovers stale enum values in the requested direction", () => {
		const field = {
			id: "model",
			label: "Model",
			type: "enum" as const,
			defaultValue: "first",
			description: "Choose the model used by this stale-value recovery fixture.",
			options: [{ value: "first" }, { value: "second" }],
			parse: (value: string) => value,
		};
		expect(cycleOption(field, "removed", 1)).toBe("first");
		expect(cycleOption(field, "removed", -1)).toBe("second");
	});

	test("keeps groups expanded while preserving selection identity", () => {
		const model = createSettingsModel([createSettingsFixture()]);
		model.select("mode");
		model.setSearch("mode");
		expect(model.state.selection?.itemId).toBe("mode");
		model.toggleGroup("general");
		expect(model.state.collapsedGroupIds.size).toBe(0);
		expect(
			visibleFields(model.active, "", model.state.collapsedGroupIds).some(
				(field) => field.id === "mode",
			),
		).toBe(true);
	});
	test("filters providers and groups with no fields", () => {
		const emptyGroup = createSettingsFixture({
			id: "empty-group",
			groups: [{ id: "empty", title: "Empty", fields: [] }],
			panels: [],
		});
		expect(createSettingsModel([emptyGroup]).state.providers).toHaveLength(0);
	});
	test("keeps duplicate field ids distinct by group while preserving public id", () => {
		const provider = createSettingsFixture({
			groups: [
				{
					id: "first",
					title: "First",
					fields: [
						{ ...createSettingsFixture().groups[0]!.fields[0]!, id: "same", label: "First same" },
					],
				},
				{
					id: "second",
					title: "Second",
					fields: [
						{ ...createSettingsFixture().groups[0]!.fields[0]!, id: "same", label: "Second same" },
					],
				},
			],
		});
		const model = createSettingsModel([provider]);
		model.select(settingFieldItemId("second", "same"));
		expect(model.state.selection).toMatchObject({ itemId: "same", groupId: "second" });
		expect(
			fieldForSelection(model.active, model.state.selection?.itemId, model.state.selection?.groupId)
				?.label,
		).toBe("Second same");
	});
});
