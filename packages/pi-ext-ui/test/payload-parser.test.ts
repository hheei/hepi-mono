import { describe, expect, test } from "vitest";
import { extractHeavyInputCommand, extractSummaryArg } from "../src/payload-parser.js";

describe("extractSummaryArg", () => {
	test("extracts summary for known built-in tools", () => {
		expect(extractSummaryArg("bash", { command: "git status" })).toBe("git status");
		expect(extractSummaryArg("bg_bash_spawn", { command: "pnpm test" })).toBe("pnpm test");
		expect(extractSummaryArg("read", { path: "src/index.ts" })).toBe("src/index.ts");
		expect(extractSummaryArg("read", { file_path: "src/file.ts" })).toBe("src/file.ts");
		expect(extractSummaryArg("edit", { path: "src/main.ts" })).toBe("src/main.ts");
		expect(extractSummaryArg("write", { path: "src/out.ts" })).toBe("src/out.ts");
		expect(extractSummaryArg("grep", { pattern: "needle", path: "src" })).toBe("needle src");
		expect(extractSummaryArg("find", { pattern: "*.ts" })).toBe("*.ts");
		expect(extractSummaryArg("python_eval", { code: "import sys\nprint(sys.version)" })).toBe(
			"import sys",
		);
		expect(extractSummaryArg("bg_bash_get", { id: "job-1" })).toBe("job-1");
		expect(extractSummaryArg("bg_bash_stop", { id: "job-2" })).toBe("job-2");
		expect(extractSummaryArg("agents_delegate", { agent: "worker", task: "fix issue" })).toBe(
			"worker: fix issue",
		);
		expect(extractSummaryArg("agents_get", { id: "agent-1" })).toBe("agent-1");
		expect(extractSummaryArg("tool_search", { query: "sqlite" })).toBe("sqlite");
	});

	test("does not guess parameters for unknown or third-party tools", () => {
		expect(extractSummaryArg("unknown_tool", { command: "run", id: "123", path: "/tmp" })).toBe("");
		expect(
			extractSummaryArg("mcp__serena__serena_repl", { code: "s.info()", project: "test" }),
		).toBe("");
		expect(
			extractSummaryArg("mcp__github__search_repos", { query: "pi", url: "https://..." }),
		).toBe("");
		expect(extractSummaryArg("custom_cli", { command: "do_something" })).toBe("");
	});
});

describe("extractHeavyInputCommand", () => {
	test("only extracts heavy command for bash, python_eval, and codemode", () => {
		expect(extractHeavyInputCommand("bash", { command: "echo hello" })).toBe("echo hello");
		expect(extractHeavyInputCommand("python_eval", { code: "1 + 1" })).toBe("1 + 1");
		expect(extractHeavyInputCommand("codemode", { code: "return 42;" })).toBe("return 42;");
		expect(extractHeavyInputCommand("other_tool", { code: "1 + 1" })).toBeUndefined();
		expect(
			extractHeavyInputCommand("mcp__serena__serena_repl", { code: "s.info()" }),
		).toBeUndefined();
	});
});
