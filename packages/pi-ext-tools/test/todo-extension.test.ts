import { join } from "node:path";
import {
	createEventBus,
	DefaultResourceLoader,
	type EventBus,
} from "@earendil-works/pi-coding-agent";
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

test("entrypoint reload keeps Todo owned by pi-ext-tools' managed registration", async () => {
	const eventBus = createEventBus();
	const resources = loader(eventBus);
	// One reload is the invariant: the entrypoint runs again and still registers `todo` once. Each
	// reload re-evaluates the extension's module graph, so a second one only repeats that work.
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
	expect(registeredTodoTools(resources)).toBe(1);
});
