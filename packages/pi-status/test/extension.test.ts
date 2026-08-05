import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	createEventBus,
	DefaultResourceLoader,
	type EventBus,
} from "@earendil-works/pi-coding-agent";

const repositoryRoot = join(import.meta.dir, "../../..");

function loader(eventBus: EventBus): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd: repositoryRoot,
		agentDir: join(repositoryRoot, ".pi"),
		eventBus,
		additionalExtensionPaths: [join(repositoryRoot, "packages/pi-status/src/extension.ts")],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
}

test("entrypoint loads without extension diagnostics", async () => {
	const resources = loader(createEventBus());
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
});
