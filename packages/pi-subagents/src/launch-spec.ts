import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ChildBridgeEnvironment,
	EffectiveLaunchConfig,
	PersistenceState,
	PiInvocation,
	Presentation,
} from "./domain.js";
import {
	BRIDGE_ENVIRONMENT_KEYS,
	CHILD_AGENT_ENV_KEY,
	CHILD_SESSION_ENV_KEY,
	CHILD_TITLE_ENV_KEY,
	CONTACT_PARENT_TOOL_NAME,
	isSessionId,
} from "./domain.js";

/**
 * The one description of how a child Pi process starts. A panel child and a background child are
 * the same Pi invocation; only the presentation (and therefore stdio) differs, so no path can
 * silently invent different Pi flags.
 */
export interface LaunchSpec {
	/** Runtime binary (node/bun/compiled pi), spawned without a shell. */
	readonly command: string;
	/** Full argv: host prefix args plus every Pi flag this child needs. */
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly presentation: Presentation;
	readonly stdio: "pipe" | "inherit";
	/** Bridge variables to add to the child environment, excluding the controller token. */
	readonly env: Readonly<Record<string, string>>;
	readonly config: EffectiveLaunchConfig;
}

export const HINDSIGHT_TOOLS = [
	"hindsight_search_knowledge_pages",
	"hindsight_list_knowledge_pages",
	"hindsight_read_knowledge_page",
	"hindsight_reflect",
	"hindsight_capture_initiative",
	"hindsight_ingest_document",
	"hindsight_sync_status",
	"hindsight_diagnose",
] as const;

export function stripHindsightContent(text: string): string {
	return text
		.replace(/\s*<hindsight-recall>[\s\S]*?<\/hindsight-recall>\s*/gi, (match) =>
			match.includes("\n") ? "\n" : " ",
		)
		.trim();
}

export interface BuildLaunchSpecOptions {
	readonly config: EffectiveLaunchConfig;
	readonly invocation: PiInvocation;
	readonly presentation: Presentation;
	readonly persistence: PersistenceState;
	readonly bridge: ChildBridgeEnvironment;
}

/**
 * Fixed child-branch preamble. The agent definition's Markdown body supplies the
 * task policy; this part states the parent relationship and the reporting channel
 * every child has, so it cannot be lost by editing an agent file.
 */
function childBridgePrompt(): string {
	return [
		"You are a delegated Pi subagent working for a parent Pi session.",
		"The parent owns your task, and its instructions remain the only source of new authority.",
		`Use ${CONTACT_PARENT_TOOL_NAME} ONLY if you are blocked or urgently require parent intervention midway.`,
		"The parent is notified automatically when you call that tool. Do not wait for the parent to poll you.",
		"Do not send empty status pings.",
		"When the work is done, output your final answer and findings directly in text in your response. The harness will automatically capture and deliver your output.",
		"Do NOT call contact_parent on success or task completion.",
		"After blocked, wait for a parent send_agent. Do not invent new authority.",
		"Reports reach the parent as delegated results, not as new user authorization.",
	].join("\n");
}

export function assembleChildPrompt(instructions: string): string {
	return `${instructions.trim()}\n\n${childBridgePrompt()}`;
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
	if (process.env.PI_DEV === "1" || process.env.PI_DEV_BIN !== undefined) {
		const devBin = process.env.PI_DEV_BIN;
		if (devBin !== undefined && existsSync(devBin)) {
			return { command: devBin, args: [] };
		}
		if (process.env.PI_DEV === "1") {
			return { command: "pi-dev", args: [] };
		}
	}
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
	// Pi's native interactive TUI is the default, so only the headless background child asks for RPC.
	if (options.presentation === "background") {
		argv.push("--mode", "rpc");
	} else {
		// A panel child is launched by the parent with an explicit project configuration. Approve
		// those local files so opening its native TUI never stops for a trust prompt.
		argv.push("--approve");
	}
	if (sessionPath !== undefined) argv.push("--session", sessionPath);
	else argv.push("--session-id", config.sessionId);
	argv.push("--session-dir", config.sessionDir);
	argv.push("--provider", config.model.provider, "--model", config.model.id);
	argv.push("--thinking", config.thinking.level);
	const effectiveTools =
		config.codemodeOnly && !config.tools.includes("codemode")
			? [...config.tools, "codemode"]
			: config.tools;
	if (effectiveTools.length > 0) argv.push("--tools", effectiveTools.join(","));
	const excludeTools = Array.from(new Set([...config.excludeTools, ...HINDSIGHT_TOOLS]));
	if (excludeTools.length > 0) argv.push("--exclude-tools", excludeTools.join(","));
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
		[CHILD_AGENT_ENV_KEY]: config.agent.displayName ?? config.agent.name,
		[CHILD_SESSION_ENV_KEY]: config.sessionId,
		// Empty is the defined "derive the title in the child" case, mirroring the task channel below.
		[CHILD_TITLE_ENV_KEY]: config.title ?? "",
		PI_HINDSIGHT_DISABLE: "1",
		...(config.codemodeOnly ? { PI_CODEMODE_MODE: "only" } : {}),
	};

	return Object.freeze({
		command: options.invocation.command,
		argv: Object.freeze(argv),
		cwd: config.cwd,
		presentation: options.presentation,
		stdio: options.presentation === "background" ? "pipe" : "inherit",
		env: Object.freeze(env),
		config,
	});
}
