import { expect, test } from "vitest";
import type {
	ChildBridgeEnvironment,
	EffectiveLaunchConfig,
	PersistenceState,
	Presentation,
} from "../src/domain.js";
import { CHILD_TITLE_ENV_KEY, STANDALONE_CONTROLLER_ENV_KEY } from "../src/domain.js";
import {
	assembleChildPrompt,
	buildLaunchSpec,
	resolvePiInvocation,
	stripHindsightContent,
	withBridgeToken,
} from "../src/launch-spec.js";

const BRIDGE_PATH = "/opt/pi subagents/dist/extension.js";
const SESSION_DIR = "/home/user/.pi/agent/sessions/--home-user-work--";
const SESSION_PATH = `${SESSION_DIR}/2026-01-01T00-00-00-000Z_01J7-session.jsonl`;

/** Atoms that must survive as single argv elements even though they contain spaces. */
const BUILT_ATOM_CLAIMS = [BRIDGE_PATH, SESSION_DIR];

const BRIDGE: ChildBridgeEnvironment = {
	parentSessionId: "01J7-parent",
	subagentId: "sa_0123456789ab",
	runtimeIdentity: "runtime-1",
	endpoint: "/tmp/pi-subagents-1.sock",
};

function launchConfig(overrides: Partial<EffectiveLaunchConfig> = {}): EffectiveLaunchConfig {
	return {
		subagentId: BRIDGE.subagentId,
		invocation: { command: "/usr/bin/node", args: ["/usr/lib/pi/cli.js"] },
		cwd: "/home/user/work dir",
		sessionId: "01J7-session",
		sessionDir: SESSION_DIR,
		agent: {
			name: "reviewer",
			hidden: false,
			sourcePath: "/home/user/work dir/.pi/agents/reviewer.md",
			instructions: "Review the change.",
		},
		model: { provider: "anthropic", id: "claude-sonnet-4", source: "agent" },
		thinking: { level: "high", source: "parent" },
		tools: ["read", "contact_parent"],
		excludeTools: [],
		extensions: { discovery: false, paths: [BRIDGE_PATH] },
		skills: { discovery: true, paths: [] },
		mcp: { enabled: true },
		prompt: assembleChildPrompt("Review the change."),
		bridgeExtensionPath: BRIDGE_PATH,
		...overrides,
	};
}

function spec(
	config: EffectiveLaunchConfig,
	presentation: Presentation,
	persistence: PersistenceState,
) {
	return buildLaunchSpec({
		config,
		invocation: config.invocation,
		presentation,
		persistence,
		bridge: BRIDGE,
	});
}

test("keeps every host and flag argv atom intact, including paths with spaces", (): void => {
	const built = spec(launchConfig(), "background", "never_flushed");
	expect(built.command).toBe("/usr/bin/node");
	expect(built.argv).toEqual([
		"/usr/lib/pi/cli.js",
		"--mode",
		"rpc",
		"--session-id",
		"01J7-session",
		"--session-dir",
		SESSION_DIR,
		"--provider",
		"anthropic",
		"--model",
		"claude-sonnet-4",
		"--thinking",
		"high",
		"--tools",
		"read,contact_parent",
		"--no-extensions",
		"-e",
		BRIDGE_PATH,
		"--append-system-prompt",
		assembleChildPrompt("Review the change."),
	]);
	expect(built.cwd).toBe("/home/user/work dir");
	expect(BUILT_ATOM_CLAIMS.every((atom) => built.argv.includes(atom))).toBe(true);
});

test("keeps skill discovery unless the definition turned it off", (): void => {
	// The built-in reviewer relies on discovery to see the review skills: naming one is not possible,
	// because `--skill` takes a path.
	const discovered = spec(launchConfig(), "background", "never_flushed");
	expect(discovered.argv).not.toContain("--no-skills");

	const narrowed = spec(
		launchConfig({ skills: { discovery: false, paths: ["/skills/ponytail-review"] } }),
		"background",
		"never_flushed",
	);
	expect(narrowed.argv).toContain("--no-skills");
	expect(narrowed.argv).toContain("--skill");
});

test("creates a never-flushed session with its recorded id and never opens an absent path", (): void => {
	const built = spec(launchConfig(), "background", "never_flushed");
	expect(built.argv).toContain("--session-id");
	expect(built.argv).not.toContain("--session");
	expect(built.argv).toContain(SESSION_DIR);
});

test("opens a flushed session by its exact path", (): void => {
	const config = launchConfig({ sessionPath: SESSION_PATH });
	const built = spec(config, "background", "flushed");
	expect(built.argv).toContain("--session");
	expect(built.argv[built.argv.indexOf("--session") + 1]).toBe(SESSION_PATH);
	expect(built.argv).not.toContain("--session-id");
});

test("builds background and panel processes from one config, differing only in presentation and stdio", (): void => {
	const config = launchConfig({ sessionPath: SESSION_PATH });
	const background = spec(config, "background", "flushed");
	const panel = spec(config, "panel", "flushed");
	expect(background.stdio).toBe("pipe");
	expect(panel.stdio).toBe("inherit");
	expect(background.presentation).toBe("background");
	expect(panel.presentation).toBe("panel");
	expect(background.argv).not.toContain("--approve");
	expect(panel.argv).toEqual([
		background.argv[0],
		"--approve",
		...background.argv.slice(1).filter((atom) => atom !== "--mode" && atom !== "rpc"),
	]);
	expect(panel.config).toBe(background.config);
});

test("carries the bridge environment without a controller token", (): void => {
	const built = spec(launchConfig(), "background", "never_flushed");
	expect(built.env).toEqual({
		PI_SUBAGENTS_PARENT_SESSION_ID: "01J7-parent",
		PI_SUBAGENTS_CHILD_ID: BRIDGE.subagentId,
		PI_SUBAGENTS_RUNTIME_ID: "runtime-1",
		PI_SUBAGENTS_ENDPOINT: "/tmp/pi-subagents-1.sock",
		PI_SUBAGENTS_AGENT: "reviewer",
		PI_SUBAGENTS_SESSION_ID: "01J7-session",
		// Stated as empty rather than left out: the child derives its own session title then.
		PI_SUBAGENTS_TITLE: "",
		PI_HINDSIGHT_DISABLE: "1",
		PI_OBSERVATIONAL_MEMORY_DISABLE: "1",
	});
	expect(JSON.stringify(built)).not.toContain("PI_SUBAGENTS_TOKEN");
	expect(Object.keys(withBridgeToken(built.env, "secret"))).toEqual([
		"PI_SUBAGENTS_PARENT_SESSION_ID",
		"PI_SUBAGENTS_CHILD_ID",
		"PI_SUBAGENTS_RUNTIME_ID",
		"PI_SUBAGENTS_ENDPOINT",
		"PI_SUBAGENTS_AGENT",
		"PI_SUBAGENTS_SESSION_ID",
		"PI_SUBAGENTS_TITLE",
		"PI_HINDSIGHT_DISABLE",
		"PI_OBSERVATIONAL_MEMORY_DISABLE",
		"PI_SUBAGENTS_TOKEN",
	]);
});

test("refuses a session placement that disagrees with the persistence state", (): void => {
	expect(() => spec(launchConfig(), "background", "flushed")).toThrow(
		/requires a known session path/u,
	);
	expect(() =>
		spec(launchConfig({ sessionPath: SESSION_PATH }), "background", "never_flushed"),
	).toThrow(/must not claim a session path/u);
});

test("refuses to launch a child whose bridge is not in the effective extension selection", (): void => {
	const config = launchConfig({ extensions: { discovery: false, paths: ["/other/extension.js"] } });
	expect(() => spec(config, "background", "never_flushed")).toThrow(/Bridge extension/u);
});

test("refuses a bridge identity that disagrees with the persisted child", (): void => {
	const config = launchConfig();
	expect(() =>
		buildLaunchSpec({
			config,
			invocation: config.invocation,
			presentation: "background",
			persistence: "never_flushed",
			bridge: { ...BRIDGE, subagentId: "sa_ffffffffffff" },
		}),
	).toThrow(/does not match launch config/u);
});

test("adds the child bridge preamble to the agent instructions", (): void => {
	const prompt = assembleChildPrompt("Review the change.");
	expect(prompt.startsWith("Review the change.\n\n")).toBe(true);
	expect(prompt).toContain("delegated Pi subagent");
	expect(prompt).toContain("contact_parent");
	expect(prompt).toContain("Do not wait for the parent to poll you");
	expect(prompt).toContain("Do not send empty status pings");
});

test("carries the spawn title, and states its absence as an empty value", (): void => {
	expect(spec(launchConfig(), "background", "never_flushed").env[CHILD_TITLE_ENV_KEY]).toBe("");
	expect(
		spec(launchConfig({ title: "OVITO properties editor" }), "background", "never_flushed").env[
			CHILD_TITLE_ENV_KEY
		],
	).toBe("OVITO properties editor");
});

test("assembles child prompt with reporting and final output guidance", (): void => {
	const prompt = assembleChildPrompt("Review the change.");
	expect(prompt).toContain("Review the change.");
	expect(prompt).toContain("After blocked, wait for a parent agent_send.");
	expect(prompt).toContain("output your final answer and findings directly in text");
});

test("buildLaunchSpec appends codemode to --tools and injects PI_CODEMODE_MODE when codemodeOnly is true", (): void => {
	const built = spec(
		launchConfig({
			codemodeOnly: true,
			tools: ["read", "grep", "contact_parent"],
		}),
		"background",
		"never_flushed",
	);
	const toolsIndex = built.argv.indexOf("--tools");
	expect(toolsIndex).toBeGreaterThan(-1);
	expect(built.argv[toolsIndex + 1]).toBe("read,grep,contact_parent,codemode");
	expect(built.env.PI_CODEMODE_MODE).toBe("only");
});

test("strips hindsight memory recall tags from tasks and inputs", (): void => {
	const raw = `Investigate this bug.\n<hindsight-recall>\npage: "Arch"\nsecret context\n</hindsight-recall>\nFocus on the parser.`;
	expect(stripHindsightContent(raw)).toBe("Investigate this bug.\nFocus on the parser.");
});

test("preserves explicit exclusions without maintaining a Hindsight tool list", (): void => {
	const built = spec(
		launchConfig({ excludeTools: ["write", "write"] }),
		"background",
		"never_flushed",
	);
	const excludeIdx = built.argv.indexOf("--exclude-tools");
	expect(excludeIdx).toBeGreaterThan(-1);
	const excluded = built.argv[excludeIdx + 1];
	expect(excluded).toBe("write");
	expect(spec(launchConfig(), "background", "never_flushed").argv).not.toContain("--exclude-tools");
});

test("resolvePiInvocation prioritizes PI_DEV_BIN when running under pi-dev", (): void => {
	const origDev = process.env.PI_DEV;
	const origDevBin = process.env.PI_DEV_BIN;
	try {
		process.env.PI_DEV = "1";
		process.env.PI_DEV_BIN = process.execPath; // known existing executable
		const inv = resolvePiInvocation();
		expect(inv).toEqual({ command: process.execPath, args: [] });

		delete process.env.PI_DEV_BIN;
		const invFallback = resolvePiInvocation();
		expect(invFallback).toEqual({ command: "pi-dev", args: [] });
	} finally {
		if (origDev !== undefined) process.env.PI_DEV = origDev;
		else delete process.env.PI_DEV;
		if (origDevBin !== undefined) process.env.PI_DEV_BIN = origDevBin;
		else delete process.env.PI_DEV_BIN;
	}
});

test("resolvePiInvocation does not relaunch the standalone controller as the child Pi", (): void => {
	const argv = process.argv;
	const origDev = process.env.PI_DEV;
	const origDevBin = process.env.PI_DEV_BIN;
	try {
		delete process.env.PI_DEV;
		delete process.env.PI_DEV_BIN;
		process.argv = [argv[0] ?? process.execPath, "/tmp/controller-main.js", "/work", "/agent"];
		const inv = resolvePiInvocation();
		expect(inv.command).toBe(process.execPath);
		expect(inv.args.join(" ")).not.toContain("controller-main");
		expect(inv.args[0]).toMatch(/cli\.js$/);
	} finally {
		process.argv = argv;
		if (origDev !== undefined) process.env.PI_DEV = origDev;
		else delete process.env.PI_DEV;
		if (origDevBin !== undefined) process.env.PI_DEV_BIN = origDevBin;
		else delete process.env.PI_DEV_BIN;
	}
});

test("buildLaunchSpec emits --no-mcp when mcp is disabled", (): void => {
	const built = spec(launchConfig({ mcp: { enabled: false } }), "background", "never_flushed");
	expect(built.argv).toContain("--no-mcp");
});

test("standalone controller children skip settings extension discovery", (): void => {
	const previous = process.env[STANDALONE_CONTROLLER_ENV_KEY];
	process.env[STANDALONE_CONTROLLER_ENV_KEY] = "1";
	try {
		const built = spec(
			launchConfig({ extensions: { discovery: true, paths: [BRIDGE_PATH] } }),
			"background",
			"never_flushed",
		);
		expect(built.argv).toContain("--no-extensions");
	} finally {
		if (previous === undefined) delete process.env[STANDALONE_CONTROLLER_ENV_KEY];
		else process.env[STANDALONE_CONTROLLER_ENV_KEY] = previous;
	}
});

test("buildLaunchSpec configures tool filtering and environment for whitelist and excluded MCP servers", (): void => {
	const whitelistBuilt = spec(
		launchConfig({ mcp: { enabled: true, servers: ["private-db", "postgres"] } }),
		"background",
		"never_flushed",
	);
	const toolsIdx = whitelistBuilt.argv.indexOf("--tools");
	expect(toolsIdx).toBeGreaterThan(-1);
	const toolsVal = whitelistBuilt.argv[toolsIdx + 1] ?? "";
	expect(toolsVal).toContain("mcp__private_db__*");
	expect(toolsVal).toContain("mcp__postgres__*");
	// Preserves default tools and contact_parent when tools was omitted
	expect(toolsVal).toContain("read");
	expect(toolsVal).toContain("contact_parent");

	expect(whitelistBuilt.argv).not.toContain("--exclude-tools");
	expect(whitelistBuilt.env.PI_SUBAGENT_MCP_SERVERS).toBe("private_db,postgres");

	const excludedBuilt = spec(
		launchConfig({ mcp: { enabled: true, excluded: ["private-db"] } }),
		"background",
		"never_flushed",
	);
	const exIdx = excludedBuilt.argv.indexOf("--exclude-tools");
	expect(exIdx).toBeGreaterThan(-1);
	expect(excludedBuilt.argv[exIdx + 1]).toContain("mcp__private_db__*");
	expect(excludedBuilt.env.PI_SUBAGENT_MCP_EXCLUDE).toBe("private_db");
});
