import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	createEventBus,
	DefaultResourceLoader,
	type EventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { observeLoadoutInventory } from "@hheei/pi-ext-core";

const repositoryRoot = join(import.meta.dir, "../../..");

function loader(eventBus: EventBus): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd: repositoryRoot,
		agentDir: join(repositoryRoot, ".pi"),
		eventBus,
		additionalExtensionPaths: [join(repositoryRoot, "packages/pi-todo/src/extension.ts")],
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

test("entrypoint reload keeps Todo owned by its managed Loadout registration", async () => {
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
	expect(snapshots).toEqual([[], ["todo"], ["todo"]]);
	abort.abort();
});
