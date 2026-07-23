import { expect, test } from "bun:test";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getHePiSettings } from "../../src/api/settings.js";

const repositoryRoot = join(import.meta.dir, "../../../..");
type LoadedExtension = ReturnType<DefaultResourceLoader["getExtensions"]>["extensions"][number];

function loader(paths: readonly string[]): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd: repositoryRoot,
		agentDir: join(repositoryRoot, ".pi"),
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

	const resources = loader([path]);
	await resources.reload();
	const extension = resources.getExtensions().extensions[0];
	if (extension === undefined) throw new Error("Expected T2S extension to load");
	await emit(extension, "session_start", ctx);
	expect(getHePiSettings("pi-t2s")).toBeDefined();
	await emit(extension, "session_shutdown", ctx);
	expect(getHePiSettings("pi-t2s")).toBeUndefined();

	await resources.reload();
	const reloadedExtension = resources.getExtensions().extensions[0];
	if (reloadedExtension === undefined) throw new Error("Expected reloaded T2S extension");
	await emit(reloadedExtension, "session_start", ctx);
	expect(getHePiSettings("pi-t2s")).toBeDefined();
	await emit(reloadedExtension, "session_shutdown", ctx);
	expect(getHePiSettings("pi-t2s")).toBeUndefined();
});
