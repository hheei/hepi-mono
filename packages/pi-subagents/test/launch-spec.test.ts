import { expect, test } from "vitest";
import type {
	ChildBridgeEnvironment,
	EffectiveLaunchConfig,
	ExecutionMode,
	PersistenceState,
} from "../src/domain.js";
import { assembleChildPrompt, buildLaunchSpec, withBridgeToken } from "../src/launch-spec.js";

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
		prompt: assembleChildPrompt("Review the change."),
		bridgeExtensionPath: BRIDGE_PATH,
		interactive: false,
		...overrides,
	};
}

function spec(config: EffectiveLaunchConfig, mode: ExecutionMode, persistence: PersistenceState) {
	return buildLaunchSpec({
		config,
		invocation: config.invocation,
		mode,
		persistence,
		bridge: BRIDGE,
	});
}

test("keeps every host and flag argv atom intact, including paths with spaces", (): void => {
	const built = spec(launchConfig(), "rpc", "never_flushed");
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

test("creates a never-flushed session with its recorded id and never opens an absent path", (): void => {
	const built = spec(launchConfig(), "rpc", "never_flushed");
	expect(built.argv).toContain("--session-id");
	expect(built.argv).not.toContain("--session");
	expect(built.argv).toContain(SESSION_DIR);
});

test("opens a flushed session by its exact path", (): void => {
	const config = launchConfig({ sessionPath: SESSION_PATH });
	const built = spec(config, "rpc", "flushed");
	expect(built.argv).toContain("--session");
	expect(built.argv[built.argv.indexOf("--session") + 1]).toBe(SESSION_PATH);
	expect(built.argv).not.toContain("--session-id");
});

test("builds RPC and TUI processes from one config, differing only in mode and stdio", (): void => {
	const config = launchConfig({ sessionPath: SESSION_PATH });
	const rpc = spec(config, "rpc", "flushed");
	const tui = spec(config, "tui", "flushed");
	expect(rpc.stdio).toBe("pipe");
	expect(tui.stdio).toBe("inherit");
	expect(rpc.mode).toBe("rpc");
	expect(tui.mode).toBe("tui");
	expect(tui.argv).toEqual(rpc.argv.filter((atom) => atom !== "--mode" && atom !== "rpc"));
	expect(tui.config).toBe(rpc.config);
});

test("carries the bridge environment without a controller token", (): void => {
	const built = spec(launchConfig(), "rpc", "never_flushed");
	expect(built.env).toEqual({
		PI_SUBAGENTS_PARENT_SESSION_ID: "01J7-parent",
		PI_SUBAGENTS_CHILD_ID: BRIDGE.subagentId,
		PI_SUBAGENTS_RUNTIME_ID: "runtime-1",
		PI_SUBAGENTS_ENDPOINT: "/tmp/pi-subagents-1.sock",
		PI_SUBAGENTS_AGENT: "reviewer",
		PI_SUBAGENTS_SESSION_ID: "01J7-session",
	});
	expect(JSON.stringify(built)).not.toContain("PI_SUBAGENTS_TOKEN");
	expect(Object.keys(withBridgeToken(built.env, "secret"))).toEqual([
		"PI_SUBAGENTS_PARENT_SESSION_ID",
		"PI_SUBAGENTS_CHILD_ID",
		"PI_SUBAGENTS_RUNTIME_ID",
		"PI_SUBAGENTS_ENDPOINT",
		"PI_SUBAGENTS_AGENT",
		"PI_SUBAGENTS_SESSION_ID",
		"PI_SUBAGENTS_TOKEN",
	]);
});

test("refuses a session placement that disagrees with the persistence state", (): void => {
	expect(() => spec(launchConfig(), "rpc", "flushed")).toThrow(/requires a known session path/u);
	expect(() => spec(launchConfig({ sessionPath: SESSION_PATH }), "rpc", "never_flushed")).toThrow(
		/must not claim a session path/u,
	);
});

test("refuses to launch a child whose bridge is not in the effective extension selection", (): void => {
	const config = launchConfig({ extensions: { discovery: false, paths: ["/other/extension.js"] } });
	expect(() => spec(config, "rpc", "never_flushed")).toThrow(/Bridge extension/u);
});

test("refuses a bridge identity that disagrees with the persisted child", (): void => {
	const config = launchConfig();
	expect(() =>
		buildLaunchSpec({
			config,
			invocation: config.invocation,
			mode: "rpc",
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
	expect(prompt).toContain("you will be reminded");
});
