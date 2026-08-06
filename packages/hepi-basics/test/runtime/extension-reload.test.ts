import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	createEventBus,
	DefaultResourceLoader,
	type EventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry } from "../../src/core/api/settings.js";

const repositoryRoot = join(import.meta.dir, "../../../..");
type LoadedExtension = ReturnType<DefaultResourceLoader["getExtensions"]>["extensions"][number];

function loader(
	paths: readonly string[],
	eventBus: EventBus = createEventBus(),
): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd: repositoryRoot,
		agentDir: join(repositoryRoot, ".pi"),
		eventBus,
		additionalExtensionPaths: [...paths],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
}

async function emit(
	extension: LoadedExtension,
	type: "session_shutdown" | "session_start",
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of extension.handlers.get(type) ?? []) await handler({ type } as never, ctx);
}

test("extension factories remain reloadable", async () => {
	const paths = [
		"packages/hepi-basics/src/core/index.ts",
		"packages/hepi-basics/src/retry/extension.ts",
		"packages/pi-dollar-skill/src/extension.ts",
		"packages/hepi-basics/src/fix/extension.ts",
		"packages/hepi-basics/src/rtk/index.ts",
	].map((path) => join(repositoryRoot, path));

	const resources = loader(paths);
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
});

test("retry registers its settings contribution for the active session", async () => {
	const path = join(repositoryRoot, "packages/hepi-basics/src/retry/extension.ts");
	const ctx = {
		cwd: join(repositoryRoot, ".pi", "retry-settings-test-missing"),
		hasUI: false,
		isProjectTrusted: () => false,
		isIdle: () => true,
		abort: () => undefined,
		sessionManager: { getSessionId: () => "retry-settings-test" },
		ui: { notify: () => undefined, setStatus: () => undefined },
	} as unknown as ExtensionContext;

	const eventBus = createEventBus();
	const resources = loader([path], eventBus);
	const settingsRegistry = getHepiRuntimeSettingsRegistry({ events: eventBus });
	await resources.reload();
	const extension = resources.getExtensions().extensions[0];
	if (extension === undefined) throw new Error("Expected retry extension to load");
	await emit(extension, "session_start", ctx);
	expect(settingsRegistry.get("pi-basics-retry")).toBeDefined();
	await emit(extension, "session_shutdown", ctx);
	expect(settingsRegistry.get("pi-basics-retry")).toBeUndefined();
});
