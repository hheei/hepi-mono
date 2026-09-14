import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "packages");
const toolsPackageDir = path.join(packageRoot, "pi-ext-tools");
const dollarSkillPackageDir = path.join(packageRoot, "pi-dollar-skill");
const settingsPackageDir = path.join(packageRoot, "pi-settings");
const mctxExtensionPath = path.join(packageRoot, "pi-mctx", "src", "index.ts");
const nativeBridgePath = path.join(toolsPackageDir, "native", "pi-ext-tools-bridge.node");
const buildCacheDir = path.join(root, ".pi-dev");
const piCliCandidates = [
	path.join(
		toolsPackageDir,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"bundle",
		"cli.js",
	),
	path.join(
		toolsPackageDir,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"cli.js",
	),
];
const piCli = piCliCandidates.find((candidate) => existsSync(candidate));
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const requiredBuildDirectories = [path.join(packageRoot, "pi-ext-core")].filter(existsSync);

if (!piCli) {
	console.error("Missing local Pi. Run pnpm install from the repository root.");
	process.exit(1);
}

function updateSourceHash(hash: ReturnType<typeof createHash>, directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const filePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			updateSourceHash(hash, filePath);
		} else if (entry.isFile() && filePath.endsWith(".ts")) {
			hash.update(filePath);
			hash.update(readFileSync(filePath));
		}
	}
}

/** Hashes every Cargo input while excluding compiler outputs. */
function updateRustSourceHash(hash: ReturnType<typeof createHash>, directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (entry.name === "target") continue;
		const filePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			updateRustSourceHash(hash, filePath);
		} else if (
			entry.isFile() &&
			(entry.name === "Cargo.toml" ||
				entry.name === "Cargo.lock" ||
				entry.name === "build.rs" ||
				entry.name.endsWith(".rs"))
		) {
			hash.update(filePath);
			hash.update(readFileSync(filePath));
		}
	}
}

function buildFingerprint(directories: readonly string[]): string {
	const hash = createHash("sha256");
	for (const filePath of [
		path.join(root, "pnpm-lock.yaml"),
		path.join(root, "tsconfig.base.json"),
	]) {
		hash.update(filePath);
		hash.update(readFileSync(filePath));
	}
	for (const directory of directories) {
		for (const fileName of ["package.json", "tsconfig.json", "tsconfig.build.json"]) {
			const filePath = path.join(directory, fileName);
			if (!existsSync(filePath)) continue;
			hash.update(filePath);
			hash.update(readFileSync(filePath));
		}
		const sourceDir = path.join(directory, "src");
		if (existsSync(sourceDir)) updateSourceHash(hash, sourceDir);
	}
	return hash.digest("hex");
}

function nativeBuildFingerprint(): string {
	const hash = createHash("sha256");
	for (const filePath of [
		path.join(root, "pnpm-lock.yaml"),
		path.join(toolsPackageDir, "package.json"),
		path.join(root, "scripts", "build-rust.mjs"),
	]) {
		hash.update(filePath);
		hash.update(readFileSync(filePath));
	}
	updateRustSourceHash(hash, path.join(root, "crates"));
	return hash.digest("hex");
}

function runWorkspaceScript(directory: string, script: string): void {
	const result = spawnSync(pnpmCommand, ["run", script], {
		cwd: directory,
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(buildCacheDir, { recursive: true });
const buildStatePath = path.join(buildCacheDir, "build.json");
const buildDirectories = [
	...requiredBuildDirectories,
	toolsPackageDir,
	dollarSkillPackageDir,
	settingsPackageDir,
];
const typescriptFingerprint = buildFingerprint(buildDirectories);
const nativeFingerprint = nativeBuildFingerprint();
let cachedTypeScriptFingerprint: string | undefined;
let cachedNativeFingerprint: string | undefined;
try {
	const cached: unknown = JSON.parse(readFileSync(buildStatePath, "utf8"));
	if (
		typeof cached === "object" &&
		cached !== null &&
		"typescriptFingerprint" in cached &&
		typeof cached.typescriptFingerprint === "string"
	) {
		cachedTypeScriptFingerprint = cached.typescriptFingerprint;
	}
	if (
		typeof cached === "object" &&
		cached !== null &&
		"nativeFingerprint" in cached &&
		typeof cached.nativeFingerprint === "string"
	) {
		cachedNativeFingerprint = cached.nativeFingerprint;
	}
} catch {
	// No cached build state requires a fresh build.
}

const needsNativeBuild =
	nativeFingerprint !== cachedNativeFingerprint || !existsSync(nativeBridgePath);
const needsTypeScriptBuild =
	cachedTypeScriptFingerprint !== typescriptFingerprint ||
	buildDirectories.some((directory) => !existsSync(path.join(directory, "dist")));

if (needsNativeBuild) {
	runWorkspaceScript(toolsPackageDir, "build:native");
}

if (needsTypeScriptBuild) {
	for (const directory of buildDirectories) runWorkspaceScript(directory, "build");
}

if (needsNativeBuild || needsTypeScriptBuild) {
	writeFileSync(
		buildStatePath,
		`${JSON.stringify({ typescriptFingerprint, nativeFingerprint })}\n`,
	);
}

const extensionArgs = [
	"--extension",
	path.join(toolsPackageDir, "dist", "extension.js"),
	"--extension",
	path.join(dollarSkillPackageDir, "dist", "extension.js"),
	"--extension",
	path.join(settingsPackageDir, "dist", "extension.js"),
	"--extension",
	mctxExtensionPath,
];
const childEnv = { ...process.env };
delete childEnv.OPENAI_API_KEY;
const result = spawnSync(
	process.execPath,
	[piCli, "--no-approve", "--no-extensions", ...extensionArgs, ...process.argv.slice(2)],
	{
		cwd: process.cwd(),
		env: childEnv,
		stdio: "inherit",
	},
);
process.exit(result.status ?? 1);
