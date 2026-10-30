import { describe, expect, test } from "vitest";
import { nativeHeavyRequest, nativeSummaryArg } from "../src/native-tools.js";

describe("extractSummaryArg", () => {
	test("extracts summary for known built-in tools", () => {
		expect(nativeSummaryArg("bash", { command: "git status" })).toBe("git status");
		expect(nativeSummaryArg("bg_bash_spawn", { command: "pnpm test" })).toBe("pnpm test");
		expect(nativeSummaryArg("read", { path: "src/index.ts" })).toBe("src/index.ts");
		expect(nativeSummaryArg("read", { file_path: "src/file.ts" })).toBe("src/file.ts");
		expect(nativeSummaryArg("edit", { path: "src/main.ts" })).toBe("src/main.ts");
		expect(nativeSummaryArg("write", { path: "src/out.ts" })).toBe("src/out.ts");
		expect(nativeSummaryArg("grep", { pattern: "needle", path: "src" })).toBe("needle src");
		expect(nativeSummaryArg("find", { pattern: "*.ts" })).toBe("*.ts");
		expect(nativeSummaryArg("python_eval", { code: "import sys\nprint(sys.version)" })).toBe(
			"import sys",
		);
		expect(nativeSummaryArg("bg_bash_get", { id: "job-1" })).toBe("job-1");
		expect(nativeSummaryArg("bg_bash_stop", { id: "job-2" })).toBe("job-2");
		expect(nativeSummaryArg("agents_delegate", { agent: "worker", task: "fix issue" })).toBe(
			"worker: fix issue",
		);
		expect(nativeSummaryArg("agents_get", { id: "agent-1" })).toBe("agent-1");
		expect(nativeSummaryArg("tool_search", { query: "sqlite" })).toBe("sqlite");
	});

	test("does not guess parameters for unknown or third-party tools", () => {
		expect(nativeSummaryArg("unknown_tool", { command: "run", id: "123", path: "/tmp" })).toBe("");
		expect(
			nativeSummaryArg("mcp__serena__serena_repl", { code: "s.info()", project: "test" }),
		).toBe("");
		expect(nativeSummaryArg("mcp__github__search_repos", { query: "pi", url: "https://..." })).toBe(
			"",
		);
		expect(nativeSummaryArg("custom_cli", { command: "do_something" })).toBe("");
	});
});

describe("extractHeavyInputCommand", () => {
	test("only extracts heavy command for bash, python_eval, and codemode", () => {
		expect(nativeHeavyRequest("bash", { command: "echo hello" })).toBe("echo hello");
		expect(nativeHeavyRequest("python_eval", { code: "1 + 1" })).toBe("1 + 1");
		expect(nativeHeavyRequest("codemode", { code: "return 42;" })).toBe("return 42;");
		expect(nativeHeavyRequest("other_tool", { code: "1 + 1" })).toBeUndefined();
		expect(nativeHeavyRequest("mcp__serena__serena_repl", { code: "s.info()" })).toBeUndefined();
	});

	test("keeps the request bytes as the model sent them", () => {
		const command = "  echo hi\n  printf '%s' \"a b\" \n";
		expect(nativeHeavyRequest("bash", { command })).toBe(command);
		expect(nativeHeavyRequest("python_eval", { code: "\n print(1)\t\n" })).toBe("\n print(1)\t\n");
		expect(nativeHeavyRequest("bash", { command: " \n\t " })).toBeUndefined();
	});
});
