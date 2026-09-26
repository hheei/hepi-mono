import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "packages");
const buildCacheDir = path.join(root, ".pi-dev");
// Extensions built and loaded automatically by pi-dev.
// Explicitly excluded from autoloading:
// - pi-ext-core: shared library, not a standalone extension entry
// - pi-debug: manual inspection tooling
const builtPackageNames = [
	"pi-ext-addon",
	"pi-ext-memory",
	"pi-ext-tools",
	"pi-optimizer",
	"pi-settings",
	"pi-status",
	"pi-subagents",
] as const;
// External extension packages loaded directly without local repository build.
const externalPackageNames = ["npm:pi-web-access"] as const;
const builtPackageDirs = builtPackageNames
	.map((name) => path.join(packageRoot, name))
	.filter(existsSync);
const toolsPackageDir = path.join(packageRoot, "pi-ext-tools");

function resolveGlobalPiCli(): string | undefined {
	if (process.env.PI_CLI && existsSync(process.env.PI_CLI)) {
		return process.env.PI_CLI;
	}
	try {
		const whichCmd = process.platform === "win32" ? "where" : "which";
		const stdout = spawnSync(whichCmd, ["pi"], { encoding: "utf8" }).stdout?.trim();
		if (!stdout) return undefined;
		const firstLine = stdout.split(/\r?\n/)[0]?.trim();
		if (!firstLine) return undefined;
		const real = realpathSync(firstLine);
		if (existsSync(real) && real.includes("pi-coding-agent")) {
			return real;
		}
	} catch {
		// Fall back to candidate paths.
	}
	return undefined;
}

const globalPiCli = resolveGlobalPiCli();
const piCliCandidates = [
	globalPiCli,
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
	path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
].filter((candidate): candidate is string => Boolean(candidate));
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

function runWorkspaceScript(directory: string, script: string): void {
	const result = spawnSync(pnpmCommand, ["run", script], {
		cwd: directory,
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(buildCacheDir, { recursive: true });
const buildStatePath = path.join(buildCacheDir, "build.json");
const buildDirectories = [...requiredBuildDirectories, ...builtPackageDirs];
const typescriptFingerprint = buildFingerprint(buildDirectories);
let cachedTypeScriptFingerprint: string | undefined;
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
} catch {
	// No cached build state requires a fresh build.
}

const needsTypeScriptBuild =
	cachedTypeScriptFingerprint !== typescriptFingerprint ||
	buildDirectories.some((directory) => !existsSync(path.join(directory, "dist")));

if (needsTypeScriptBuild) {
	for (const directory of buildDirectories) runWorkspaceScript(directory, "build");
	writeFileSync(buildStatePath, `${JSON.stringify({ typescriptFingerprint })}\n`);
}

const extensionArgs: string[] = [];
for (const directory of builtPackageDirs) {
	const extensionPath = path.join(directory, "dist", "extension.js");
	if (existsSync(extensionPath)) {
		extensionArgs.push("--extension", extensionPath);
	}
}
for (const pkg of externalPackageNames) {
	extensionArgs.push("--extension", pkg);
}
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
