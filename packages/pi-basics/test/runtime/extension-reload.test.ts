import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	createEventBus,
	DefaultResourceLoader,
	type EventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getHePiRuntimeModuleRegistry } from "../../src/api/modules.js";
import { getHePiRuntimeSettingsRegistry } from "../../src/api/settings.js";

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

test("concurrent extension runtimes isolate contributions", async () => {
	const path = join(repositoryRoot, "packages/pi-basics/src/index.ts");
	const firstBus = createEventBus();
	const secondBus = createEventBus();
	const firstResources = loader([path], firstBus);
	const secondResources = loader([path], secondBus);
	await Promise.all([firstResources.reload(), secondResources.reload()]);
	const firstExtension = firstResources.getExtensions().extensions[0];
	const secondExtension = secondResources.getExtensions().extensions[0];
	if (firstExtension === undefined || secondExtension === undefined)
		throw new Error("Expected Basics extensions to load");
	firstResources.getExtensions().runtime.getActiveTools = () => [];
	firstResources.getExtensions().runtime.setActiveTools = () => undefined;
	secondResources.getExtensions().runtime.getActiveTools = () => [];
	secondResources.getExtensions().runtime.setActiveTools = () => undefined;
	const context = (sessionId: string) =>
		({
			cwd: repositoryRoot,
			mode: "json",
			sessionManager: { getSessionId: () => sessionId },
			ui: {},
		}) as unknown as ExtensionContext;

	await emit(firstExtension, "session_start", context("first"));
	await emit(secondExtension, "session_start", context("second"));
	const firstRegistry = getHePiRuntimeModuleRegistry({ events: firstBus });
	const secondRegistry = getHePiRuntimeModuleRegistry({ events: secondBus });
	if (firstRegistry.get("setting") === undefined || secondRegistry.get("setting") === undefined)
		throw new Error("Expected isolated Settings modules");
	await emit(firstExtension, "session_shutdown", context("first"));
	if (firstRegistry.get("setting") !== undefined) throw new Error("Expected first module cleanup");
	if (secondRegistry.get("setting") === undefined)
		throw new Error("Expected second module to remain");
	await emit(secondExtension, "session_shutdown", context("second"));
});

test("extension factories remain reloadable", async () => {
	const paths = [
		"packages/pi-basics/src/index.ts",
		"packages/pi-loadout/src/extension.ts",
		"packages/pi-dollar-skill/src/extension.ts",
		"packages/pi-fix/src/extension.ts",
		"packages/pi-rtk/src/index.ts",
		"packages/pi-t2s/src/extension.ts",
	].map((path) => join(repositoryRoot, path));

	const resources = loader(paths);
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
});

test("session shutdown removes a settings contribution before reload", async () => {
	const path = join(repositoryRoot, "packages/pi-t2s/src/extension.ts");
	const ctx = {
		cwd: join(repositoryRoot, ".pi", "reload-test-missing"),
		sessionManager: { getSessionId: () => "reload-test" },
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;

	const eventBus = createEventBus();
	const resources = loader([path], eventBus);
	const settingsRegistry = getHePiRuntimeSettingsRegistry({ events: eventBus });
	await resources.reload();
	const extension = resources.getExtensions().extensions[0];
	if (extension === undefined) throw new Error("Expected T2S extension to load");
	await emit(extension, "session_start", ctx);
	expect(settingsRegistry.get("pi-t2s")).toBeDefined();
	await emit(extension, "session_shutdown", ctx);
	expect(settingsRegistry.get("pi-t2s")).toBeUndefined();

	await resources.reload();
	const reloadedExtension = resources.getExtensions().extensions[0];
	if (reloadedExtension === undefined) throw new Error("Expected reloaded T2S extension");
	await emit(reloadedExtension, "session_start", ctx);
	expect(settingsRegistry.get("pi-t2s")).toBeDefined();
	await emit(reloadedExtension, "session_shutdown", ctx);
	expect(settingsRegistry.get("pi-t2s")).toBeUndefined();
});
