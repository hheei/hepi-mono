import { expect, test } from "bun:test";
import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = join(import.meta.dir, "../../..");
const packagesDirectory = join(repositoryRoot, "packages");
const allowedFeatureDependency = "@hheei/pi-basics";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageDependencies(manifest: Record<string, unknown>): readonly string[] {
	return ["dependencies", "devDependencies", "peerDependencies"]
		.flatMap((key) => {
			const values = manifest[key];
			return isRecord(values) ? Object.keys(values) : [];
		})
		.filter((name) => name.startsWith("@hheei/pi-"));
}

function hepiPackageImports(source: string): readonly string[] {
	return [
		...source.matchAll(/from\s+["'](@hheei\/pi-[^"']+)["']/gu),
		...source.matchAll(/\bimport\s+["'](@hheei\/pi-[^"']+)["']/gu),
		...source.matchAll(/\bimport\s*\(\s*["'](@hheei\/pi-[^"']+)["']\s*\)/gu),
	].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

async function sourceFiles(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
		}),
	);
	return nested.flat();
}

async function packagePaths(): Promise<readonly string[]> {
	const directories = await readdir(packagesDirectory, { withFileTypes: true });
	return directories
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-"))
		.map((entry) => join(packagesDirectory, entry.name));
}

test("HEPI feature packages only depend on pi-basics", async () => {
	for (const packagePath of await packagePaths()) {
		const manifestPath = join(packagePath, "package.json");
		const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
		if (!isRecord(manifest)) throw new Error(`Expected object manifest: ${manifestPath}`);
		for (const dependency of packageDependencies(manifest))
			expect(
				dependency,
				`${relative(repositoryRoot, manifestPath)} cannot depend on ${dependency}`,
			).toBe(allowedFeatureDependency);

		const sourceDirectory = join(packagePath, "src");
		for (const sourcePath of await sourceFiles(sourceDirectory)) {
			const source = await readFile(sourcePath, "utf8");
			for (const dependency of hepiPackageImports(source))
				expect(
					dependency,
					`${relative(repositoryRoot, sourcePath)} cannot import ${dependency}`,
				).toBe(allowedFeatureDependency);
		}
	}
});

test("dependency scanner covers static and dynamic imports", () => {
	expect(
		hepiPackageImports(`
			import { a } from "@hheei/pi-basics";
			import "@hheei/pi-side-effect";
			const b = await import("@hheei/pi-other");
		`),
	).toEqual(["@hheei/pi-basics", "@hheei/pi-side-effect", "@hheei/pi-other"]);
});

test("declared Pi extension entries exist and export a loader", async () => {
	for (const packagePath of await packagePaths()) {
		const manifestPath = join(packagePath, "package.json");
		const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
		if (!isRecord(manifest) || !isRecord(manifest.pi) || !Array.isArray(manifest.pi.extensions))
			throw new Error(`Missing pi.extensions: ${manifestPath}`);
		for (const entry of manifest.pi.extensions) {
			if (typeof entry !== "string") throw new Error(`Invalid Pi extension entry: ${manifestPath}`);
			const extensionPath = join(packagePath, entry);
			await access(extensionPath);
			const extension: unknown = await import(pathToFileURL(extensionPath).href);
			if (!isRecord(extension)) throw new Error(`Invalid extension module: ${extensionPath}`);
			expect(typeof extension.default, relative(repositoryRoot, extensionPath)).toBe("function");
		}
	}
});
