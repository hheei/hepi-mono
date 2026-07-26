import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdvisorSettingsProvider } from "../../../../src/pi-advisor/settings.js";

type Context = { readonly sessionId: string; readonly cwd: string };
const context: Context = { sessionId: "test", cwd: "/tmp" };

async function target(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-basics-advisor-"));
	return join(directory, "settings.json");
}

describe("advisor settings provider", () => {
	test("uses one model field with configured options and Tab thinking cycle", () => {
		const provider = createAdvisorSettingsProvider({
			path: "/tmp/settings.json",
			modelOptions: [{ value: "openai/gpt-4.1", label: "GPT-4.1" }],
		});
		expect(provider.id).toBe("pi-basics-advisor");
		expect(provider.groups[0]?.id).toBe("advisor");
		expect(provider.groups[0]?.fields).toHaveLength(1);
		const field = provider.groups[0]?.fields[0];
		expect(field).toMatchObject({
			id: "model",
			label: "Advisor model",
			type: "enum",
			options: [{ value: "openai/gpt-4.1", label: "GPT-4.1" }],
			tabCycle: { fieldId: "thinking", defaultValue: "medium" },
		});
		expect(field?.formatDisplay?.("openai/gpt-4.1", "low")).toBe("◔ openai/gpt-4.1");
		expect(field?.formatDescription?.("openai/gpt-4.1", "low")).toBe("openai/gpt-4.1 low");
	});

	test("normalizes blank model and passes it to persistence callback", async () => {
		const path = await target();
		let persisted: string | undefined = "unset";
		const provider = createAdvisorSettingsProvider({
			path,
			onPersisted: (model) => {
				persisted = model;
			},
		});
		await provider.storage.save({ advisor: { model: "  ", thinking: "medium" } }, context);
		expect(persisted).toBeUndefined();
		expect(await readFile(path, "utf8")).not.toContain('"model"');
	});

	test("validates before persistence and reconfigures after persistence", async () => {
		const path = await target();
		const events: string[] = [];
		const provider = createAdvisorSettingsProvider({
			path,
			validatePersisted: () => {
				events.push("validate");
			},
			onPersisted: async (model) => {
				const persisted = JSON.parse(await readFile(path, "utf8")) as {
					readonly [key: string]: unknown;
				};
				const settings = persisted["pi-basics"] as {
					readonly advisor?: { readonly model?: unknown };
				};
				expect(settings.advisor?.model).toBe(model);
				events.push("persisted observed");
				events.push("reconfigure");
			},
		});
		await provider.storage.save({ advisor: { model: "provider/model", thinking: "low" } }, context);
		expect(events).toEqual(["validate", "persisted observed", "reconfigure"]);
	});

	test("does not mutate the file or callback when validation fails", async () => {
		const path = await target();
		await Bun.write(path, '{"pi-basics":{"advisor":{"model":"old/model"}}}\n');
		let called = false;
		const provider = createAdvisorSettingsProvider({
			path,
			validatePersisted: () => {
				throw new Error("invalid");
			},
			onPersisted: () => {
				called = true;
			},
		});
		await expect(
			provider.storage.save({ advisor: { model: "new/model", thinking: "medium" } }, context),
		).rejects.toThrow("invalid");
		expect(await readFile(path, "utf8")).toBe('{"pi-basics":{"advisor":{"model":"old/model"}}}\n');
		expect(called).toBe(false);
	});

	test("does not callback when persistence fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-basics-advisor-"));
		const path = join(directory, "settings.json");
		await Bun.write(path, "not json");
		let called = false;
		const provider = createAdvisorSettingsProvider({
			path,
			onPersisted: () => {
				called = true;
			},
		});
		await expect(
			provider.storage.save({ advisor: { thinking: "medium" } }, context),
		).rejects.toBeDefined();
		expect(called).toBe(false);
	});
});
