import { expect, test } from "bun:test";
import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = join(import.meta.dir, "../../..");
const packagesDirectory = join(repositoryRoot, "packages");
const allowedFeatureDependency = "@hheei/pi-basics";
const compositionPackages = new Set(["hepi-basics", "hepi-mono", "hepi-skills", "hepi-tools"]);
const submodulePackages = new Set(["pi-magic-context", "pi-subagents"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimePackageDependencies(manifest: Record<string, unknown>): readonly string[] {
	return ["dependencies", "peerDependencies"]
		.flatMap((key) => {
			const values = manifest[key];
			return isRecord(values) ? Object.keys(values) : [];
		})
		.filter((name) => name.startsWith("@hheei/pi-"));
}

interface HePiPackageImport {
	readonly name: string;
	readonly runtimeStatic: boolean;
}

function runtimeImportClause(clause: ts.ImportClause | undefined): boolean {
	if (clause === undefined) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name !== undefined) return true;
	const bindings = clause.namedBindings;
	if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
	return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
}

function hepiPackageImports(source: string): readonly HePiPackageImport[] {
	const imports: HePiPackageImport[] = [];
	const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, false);
	const add = (name: string, runtimeStatic: boolean): void => {
		if (name.startsWith("@hheei/pi-")) imports.push({ name, runtimeStatic });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
			add(node.moduleSpecifier.text, runtimeImportClause(node.importClause));
		else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const runtime =
				!node.isTypeOnly &&
				(node.exportClause === undefined ||
					ts.isNamespaceExport(node.exportClause) ||
					node.exportClause.elements.some((element) => !element.isTypeOnly));
			add(node.moduleSpecifier.text, runtime);
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const argument = node.arguments[0];
			if (
				argument !== undefined &&
				(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
			)
				add(argument.text, false);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return imports;
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
	const packageDirectories = directories.filter(
		(entry) => entry.isDirectory() && !submodulePackages.has(entry.name),
	);
	const unexpected = packageDirectories
		.map((entry) => entry.name)
		.filter((name) => !name.startsWith("pi-") && !compositionPackages.has(name));
	if (unexpected.length > 0)
		throw new Error(`Unexpected workspace directories under packages/: ${unexpected.join(", ")}`);
	return packageDirectories.map((entry) => join(packagesDirectory, entry.name));
}

async function featurePackagePaths(): Promise<readonly string[]> {
	return (await packagePaths()).filter((packagePath) =>
		relative(packagesDirectory, packagePath).startsWith("pi-"),
	);
}

test("workspace contains only HEPI-owned Pi packages", async () => {
	const rootManifest: unknown = JSON.parse(
		await readFile(join(repositoryRoot, "package.json"), "utf8"),
	);
	if (!isRecord(rootManifest)) throw new Error("Expected object root package manifest");
	expect(rootManifest.workspaces).toEqual([
		"packages/*",
		"!packages/pi-magic-context",
		"!packages/pi-subagents",
	]);

	for (const packagePath of await packagePaths()) {
		const directory = relative(packagesDirectory, packagePath);
		const manifestPath = join(packagePath, "package.json");
		const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
		if (!isRecord(manifest)) throw new Error(`Expected object manifest: ${manifestPath}`);
		expect(manifest.name).toBe(`@hheei/${directory}`);
		const repository = manifest.repository;
		if (!isRecord(repository)) throw new Error(`Missing repository metadata: ${manifestPath}`);
		expect(repository.directory).toBe(`packages/${directory}`);
	}
});

test("repository does not track external or generated trees", () => {
	const result = Bun.spawnSync(["git", "ls-files", "--stage"], {
		cwd: repositoryRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(`Unable to inspect tracked files: ${result.stderr.toString()}`);
	const entries = result.stdout
		.toString()
		.trim()
		.split("\n")
		.filter((line) => line !== "");
	for (const entry of entries) {
		if (entry.startsWith("160000 ")) {
			const path = entry.slice(entry.indexOf("\t") + 1);
			expect(submodulePackages).toContain(path.replace(/^packages\//u, ""));
		}
	}
	const paths = entries.map((entry) => entry.slice(entry.indexOf("\t") + 1));
	const excludedRoots = [
		"graphify-out/",
		"legacy/",
		"outputs/",
		"pi-agent/",
		"references/repos/",
	] as const;
	for (const root of excludedRoots)
		expect(
			paths.some((path) => path.startsWith(root)),
			`tracked path under ${root}`,
		).toBe(false);
	expect(paths.some((path) => /^pi-session-.*\.html$/u.test(path))).toBe(false);
});

test("HEPI feature packages only depend on pi-basics", async () => {
	for (const packagePath of await featurePackagePaths()) {
		const manifestPath = join(packagePath, "package.json");
		const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
		if (!isRecord(manifest)) throw new Error(`Expected object manifest: ${manifestPath}`);
		for (const dependency of runtimePackageDependencies(manifest))
			expect(
				dependency,
				`${relative(repositoryRoot, manifestPath)} cannot depend on ${dependency}`,
			).toBe(allowedFeatureDependency);

		const peerDependenciesMeta = manifest.peerDependenciesMeta;
		const basicsPeerMeta = isRecord(peerDependenciesMeta)
			? peerDependenciesMeta[allowedFeatureDependency]
			: undefined;
		const basicsIsOptional = isRecord(basicsPeerMeta) && basicsPeerMeta.optional === true;
		const sourceDirectory = join(packagePath, "src");
		for (const sourcePath of await sourceFiles(sourceDirectory)) {
			const source = await readFile(sourcePath, "utf8");
			const imports = hepiPackageImports(source);
			if (basicsIsOptional)
				expect(
					imports
						.filter((dependency) => dependency.runtimeStatic)
						.map((dependency) => dependency.name),
					`${relative(repositoryRoot, sourcePath)} cannot statically import optional ${allowedFeatureDependency}`,
				).not.toContain(allowedFeatureDependency);
			for (const dependency of imports)
				expect(
					dependency.name,
					`${relative(repositoryRoot, sourcePath)} cannot import ${dependency.name}`,
				).toBe(allowedFeatureDependency);
		}
	}
});

test("HEPI composition packages expose one bundled extension entry", async () => {
	for (const packagePath of (await packagePaths()).filter((path) =>
		compositionPackages.has(relative(packagesDirectory, path)),
	)) {
		const manifest: unknown = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"));
		if (!isRecord(manifest)) throw new Error(`Expected object manifest: ${packagePath}`);
		const entries = isRecord(manifest.pi) ? manifest.pi.extensions : undefined;
		expect(entries).toEqual(["src/extension.ts"]);
		const bundledDependencies = manifest.bundledDependencies;
		expect(Array.isArray(bundledDependencies)).toBe(true);
		if (!Array.isArray(bundledDependencies))
			throw new Error(`Missing bundled dependencies: ${packagePath}`);
		expect(bundledDependencies.length).toBeGreaterThan(0);
	}
});

test("dependency scanner covers static and dynamic imports", () => {
	const source = `
		import { a } from "@hheei/pi-basics";
		import type { B } from "@hheei/pi-types";
		import "@hheei/pi-side-effect";
		export type { C } from "@hheei/pi-export-types";
		const b = await import("@hheei/pi-other");
		const c = await import(\`@hheei/pi-template\`);
		const d = await import("@hheei/pi-options", { with: { type: "json" } });
	`;
	expect(hepiPackageImports(source)).toEqual([
		{ name: "@hheei/pi-basics", runtimeStatic: true },
		{ name: "@hheei/pi-types", runtimeStatic: false },
		{ name: "@hheei/pi-side-effect", runtimeStatic: true },
		{ name: "@hheei/pi-export-types", runtimeStatic: false },
		{ name: "@hheei/pi-other", runtimeStatic: false },
		{ name: "@hheei/pi-template", runtimeStatic: false },
		{ name: "@hheei/pi-options", runtimeStatic: false },
	]);
});

test("all Pi packages expose explicit root contracts", async () => {
	for (const packagePath of await packagePaths()) {
		const manifestPath = join(packagePath, "package.json");
		const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
		if (!isRecord(manifest) || !isRecord(manifest.exports))
			throw new Error(`Missing package exports: ${manifestPath}`);
		expect(manifest.exports["."]).toBe("./src/index.ts");
		const publicRoot = await readFile(join(packagePath, "src", "index.ts"), "utf8");
		expect(publicRoot).not.toMatch(/export\s+\*\s+from/u);
	}
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
