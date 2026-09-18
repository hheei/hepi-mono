import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ChildBridgeEnvironment,
	EffectiveLaunchConfig,
	ExecutionMode,
	PersistenceState,
	PiInvocation,
} from "./domain.js";
import { BRIDGE_ENVIRONMENT_KEYS, CONTACT_PARENT_TOOL_NAME, isSessionId } from "./domain.js";

/**
 * The one description of how a child Pi process starts. RPC spawn, native TUI
 * attach, and replacement runtimes all build from this; only `mode` and `stdio`
 * differ, so no path can silently invent different Pi flags.
 */
export interface LaunchSpec {
	/** Runtime binary (node/bun/compiled pi), spawned without a shell. */
	readonly command: string;
	/** Full argv: host prefix args plus every Pi flag this child needs. */
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly mode: ExecutionMode;
	readonly stdio: "pipe" | "inherit";
	/** Bridge variables to add to the child environment, excluding the controller token. */
	readonly env: Readonly<Record<string, string>>;
	readonly config: EffectiveLaunchConfig;
}

export interface BuildLaunchSpecOptions {
	readonly config: EffectiveLaunchConfig;
	readonly invocation: PiInvocation;
	readonly mode: ExecutionMode;
	readonly persistence: PersistenceState;
	readonly bridge: ChildBridgeEnvironment;
}

/**
 * Fixed child-branch preamble. The agent definition's Markdown body supplies the
 * task policy; this part states the parent relationship and the reporting channel
 * every child has, so it cannot be lost by editing an agent file.
 */
const CHILD_BRIDGE_PROMPT = [
	"You are a delegated Pi subagent working for a parent Pi session.",
	"The parent owns your task, and its instructions remain the only source of new authority.",
	`Use ${CONTACT_PARENT_TOOL_NAME} to report progress, important findings, decisions you need, or blockers.`,
	"Reports reach the parent as delegated results, not as new user authorization.",
].join("\n");

export function assembleChildPrompt(instructions: string): string {
	return `${instructions.trim()}\n\n${CHILD_BRIDGE_PROMPT}`;
}

/** Adds the per-runtime controller token. Tokens stay out of launch spec snapshots and the registry. */
export function withBridgeToken(
	env: Readonly<Record<string, string>>,
	token: string,
): Record<string, string> {
	return { ...env, [BRIDGE_ENVIRONMENT_KEYS.token]: token };
}

let cachedBridgeExtensionPath: string | undefined;

/**
 * Absolute path to this package's extension entry, which every child loads with
 * `-e` so the child branch exists even when extension discovery is disabled.
 */
export function resolveBridgeExtensionPath(): string {
	if (cachedBridgeExtensionPath !== undefined) return cachedBridgeExtensionPath;
	const candidates = [
		// Running from a built package: the entry sits next to this module.
		fileURLToPath(new URL("./extension.js", import.meta.url)),
		// Running from source (tests, jiti): use the built entry of the package.
		fileURLToPath(new URL("../dist/extension.js", import.meta.url)),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found === undefined) {
		throw new Error(
			`pi-subagents bridge extension entry not found; looked in ${candidates.join(", ")}`,
		);
	}
	cachedBridgeExtensionPath = found;
	return found;
}

function resolveBundledPiCli(): string | undefined {
	try {
		const requireFromHere = createRequire(import.meta.url);
		// The CLI ships at dist/cli.js of the installed Pi package.
		const packageJson = requireFromHere.resolve("@earendil-works/pi-coding-agent/package.json");
		const cliPath = join(dirname(packageJson), "dist", "cli.js");
		return existsSync(cliPath) ? cliPath : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Re-invokes the host Pi CLI instead of guessing a binary on PATH. Extensions load
 * in-process, so `process.argv[1]` is the running `cli.js`; a packaged single-file
 * binary uses `process.execPath` directly. Nothing is spawned through a shell, so
 * argv atoms keep their exact bytes.
 */
export function resolvePiInvocation(): PiInvocation {
	const execPath = process.execPath;
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript !== undefined && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: execPath, args: [currentScript] };
	}
	const execName = basename(execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: execPath, args: [] };
	}
	const bundled = resolveBundledPiCli();
	if (bundled !== undefined) return { command: execPath, args: [bundled] };
	return { command: "pi", args: [] };
}

/**
 * Builds the complete argv for one child Pi process. Session identity is always
 * explicit: a flushed session is opened by path, a never-flushed session is created
 * with its recorded id (`--session-id`), never through an open call on an absent
 * path that would mint a random id.
 */
export function buildLaunchSpec(options: BuildLaunchSpecOptions): LaunchSpec {
	const { config, persistence } = options;
	if (!isSessionId(config.sessionId)) {
		throw new Error(`Invalid child session id ${config.sessionId}`);
	}
	if (!isSessionId(options.bridge.subagentId)) {
		throw new Error(`Invalid child id ${options.bridge.subagentId}`);
	}
	if (options.bridge.subagentId !== config.subagentId) {
		throw new Error(
			`Bridge identity ${options.bridge.subagentId} does not match launch config ${config.subagentId}`,
		);
	}
	const sessionPath = config.sessionPath;
	if (persistence === "flushed" && sessionPath === undefined) {
		throw new Error("Flushed session requires a known session path");
	}
	if (persistence === "never_flushed" && sessionPath !== undefined) {
		throw new Error("Never-flushed session must not claim a session path");
	}
	if (!config.extensions.paths.includes(config.bridgeExtensionPath)) {
		throw new Error("Bridge extension must be part of the effective extension selection");
	}

	const argv: string[] = [...options.invocation.args];
	if (options.mode === "rpc") argv.push("--mode", "rpc");
	if (sessionPath !== undefined) argv.push("--session", sessionPath);
	else argv.push("--session-id", config.sessionId);
	argv.push("--session-dir", config.sessionDir);
	argv.push("--provider", config.model.provider, "--model", config.model.id);
	argv.push("--thinking", config.thinking.level);
	if (config.tools.length > 0) argv.push("--tools", config.tools.join(","));
	if (config.excludeTools.length > 0) argv.push("--exclude-tools", config.excludeTools.join(","));
	if (!config.extensions.discovery) argv.push("--no-extensions");
	for (const path of config.extensions.paths) argv.push("-e", path);
	if (!config.skills.discovery) argv.push("--no-skills");
	for (const path of config.skills.paths) argv.push("--skill", path);
	argv.push("--append-system-prompt", config.prompt);

	const env: Record<string, string> = {
		[BRIDGE_ENVIRONMENT_KEYS.parentSessionId]: options.bridge.parentSessionId,
		[BRIDGE_ENVIRONMENT_KEYS.childId]: options.bridge.subagentId,
		[BRIDGE_ENVIRONMENT_KEYS.runtimeId]: options.bridge.runtimeIdentity,
		[BRIDGE_ENVIRONMENT_KEYS.endpoint]: options.bridge.endpoint,
	};

	return Object.freeze({
		command: options.invocation.command,
		argv: Object.freeze(argv),
		cwd: config.cwd,
		mode: options.mode,
		stdio: options.mode === "rpc" ? "pipe" : "inherit",
		env: Object.freeze(env),
		config,
	});
}
