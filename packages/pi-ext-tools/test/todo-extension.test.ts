import { join } from "node:path";
import {
	createEventBus,
	DefaultResourceLoader,
	type EventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { observeLoadoutInventory } from "@hheei/pi-ext-core";
import { expect, test } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../../..");

function loader(eventBus: EventBus): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd: repositoryRoot,
		agentDir: join(repositoryRoot, ".pi"),
		eventBus,
		additionalExtensionPaths: [join(repositoryRoot, "packages/pi-ext-tools/src/extension.ts")],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
}

function registeredTodoTools(resources: DefaultResourceLoader): number {
	const extension = resources.getExtensions().extensions[0];
	if (extension === undefined) throw new Error("Expected Todo extension to load");
	return [...extension.tools.keys()].filter((name) => name === "todo").length;
}

test("entrypoint reload keeps Todo owned by pi-ext-tools' managed Loadout registration", async () => {
	const eventBus = createEventBus();
	const abort = new AbortController();
	const snapshots: string[][] = [];
	observeLoadoutInventory({ events: eventBus } as unknown as ExtensionAPI, {
		signal: abort.signal,
		onChange(items) {
			snapshots.push(items.map((item) => item.id));
		},
	});

	const resources = loader(eventBus);
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
	expect(registeredTodoTools(resources)).toBe(1);

	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
	expect(registeredTodoTools(resources)).toBe(1);
	expect(snapshots[0]).toEqual([]);
	expect(
		snapshots.every((ids, index) => index === 0 || ids.filter((id) => id === "todo").length === 1),
	).toBe(true);
	abort.abort();
});
