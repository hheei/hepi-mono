import { describe, expect, it } from "vitest";
import { resolveDefaultBashTimeout } from "../src/bash.js";
import {
	extractShellCommands,
	isSearchOnlyCommand,
	SEARCH_BASH_TIMEOUT_SECONDS,
} from "../src/bash-search.js";

describe("bash-search detector", () => {
	it("correctly extracts shell commands with quotes and separators", () => {
		expect(extractShellCommands("rg 'hello world' | head -n 10")).toEqual([
			["rg", "'hello world'"],
			["head", "-n", "10"],
		]);
		expect(extractShellCommands("find . -name '*.ts' && grep -E 'abc' file.txt")).toEqual([
			["find", ".", "-name", "'*.ts'"],
			["grep", "-E", "'abc'", "file.txt"],
		]);
		expect(extractShellCommands("rg 'foo; bar && baz'")).toEqual([["rg", "'foo; bar && baz'"]]);
	});

	it("identifies pure search commands as search-only", () => {
		const searchCommands = [
			"rg 'foo'",
			'ripgrep "hello world"',
			"fd -e ts",
			"fdfind -e json",
			"grep -rn 'pattern' .",
			"egrep -i 'foo' src/",
			"fgrep -F 'bar' .",
			"find . -name '*.ts'",
			"/usr/bin/find . -maxdepth 2",
			"/usr/local/bin/rg test",
			"LC_ALL=C grep -r 'foo' .",
			"env LC_ALL=C rg -i 'test'",
			"command rg 'foo'",
			"rg 'foo' | head -n 10",
			"find . -type f | wc -l",
			"fd 'test' | sort | uniq -c",
			"grep 'foo' file.txt | tail -n 20 | awk '{print $1}'",
			"find src/ -type f | xargs grep -n 'TODO'",
			"find src/ | xargs -n 1 wc -l",
			"rg 'foo; bar'",
			"rg 'foo' && find . -name '*.json'",
		];

		for (const cmd of searchCommands) {
			expect(isSearchOnlyCommand(cmd), `expected ${cmd} to be search-only`).toBe(true);
		}
	});

	it("rejects non-search or mixed commands", () => {
		const nonSearchCommands = [
			"pnpm test",
			"npm run build && rg foo",
			"git status | grep modified",
			"cargo build 2>&1 | rg error",
			"python3 -c 'print(1)' | grep 1",
			"cat package.json",
			"head -n 10 file.txt",
			"echo 'hello' | grep hello",
			"node -e \"console.log('hi')\"",
			"rg $(cat list.txt)",
			"find . -name '`git rev-parse`'",
			"",
			"   ",
		];

		for (const cmd of nonSearchCommands) {
			expect(isSearchOnlyCommand(cmd), `expected ${cmd} NOT to be search-only`).toBe(false);
		}
	});

	it("resolves default timeout to 25s for search and 180s for non-search", () => {
		expect(SEARCH_BASH_TIMEOUT_SECONDS).toBe(25);
		expect(resolveDefaultBashTimeout("rg 'query'")).toBe(25);
		expect(resolveDefaultBashTimeout("find . -name '*.ts' | head -n 5")).toBe(25);
		expect(resolveDefaultBashTimeout("pnpm test")).toBe(180);
		expect(resolveDefaultBashTimeout("git status && rg 'query'")).toBe(180);
	});
});
