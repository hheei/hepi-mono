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

	test("normalizes a blank model before persistence", async () => {
		const path = await target();
		const provider = createAdvisorSettingsProvider({ path });
		await provider.storage.save({ advisor: { model: "  ", thinking: "medium" } }, context);
		expect(await readFile(path, "utf8")).not.toContain('"model"');
	});

	test("validates before persistence without reconfiguring a live Advisor", async () => {
		const path = await target();
		const events: string[] = [];
		const provider = createAdvisorSettingsProvider({
			path,
			validatePersisted: () => {
				events.push("validate");
			},
		});
		await provider.storage.save({ advisor: { model: "provider/model", thinking: "low" } }, context);
		expect(events).toEqual(["validate"]);
	});

	test("does not mutate the file or callback when validation fails", async () => {
		const path = await target();
		await Bun.write(path, '{"hepi":{"advisor":{"model":"old/model"}}}\n');
		const provider = createAdvisorSettingsProvider({
			path,
			validatePersisted: () => {
				throw new Error("invalid");
			},
		});
		await expect(
			provider.storage.save({ advisor: { model: "new/model", thinking: "medium" } }, context),
		).rejects.toThrow("invalid");
		expect(await readFile(path, "utf8")).toBe('{"hepi":{"advisor":{"model":"old/model"}}}\n');
	});

	test("does not write when persistence fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-basics-advisor-"));
		const path = join(directory, "settings.json");
		await Bun.write(path, "not json");
		const provider = createAdvisorSettingsProvider({ path });
		await expect(
			provider.storage.save({ advisor: { thinking: "medium" } }, context),
		).rejects.toBeDefined();
	});
});
