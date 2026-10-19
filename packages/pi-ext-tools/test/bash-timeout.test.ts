import { extractShellCommands, isSearchOnlyCommand } from "@hheei/pi-ext-core";
import { describe, expect, it } from "vitest";
import { resolveDefaultBashTimeout } from "../src/bash.js";

describe("bash-search detector", () => {
	it.each([
		[
			"rg 'hello world' | head -n 10",
			[
				["rg", "'hello world'"],
				["head", "-n", "10"],
			],
		],
		[
			"find . -name '*.ts' && grep -E 'abc' file.txt",
			[
				["find", ".", "-name", "'*.ts'"],
				["grep", "-E", "'abc'", "file.txt"],
			],
		],
		["rg 'foo; bar && baz'", [["rg", "'foo; bar && baz'"]]],
	] as const)("extracts %s", (command, expected) => {
		expect(extractShellCommands(command)).toEqual(expected);
	});

	it.each([
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
	])("treats search command %s as search-only", (command) => {
		expect(isSearchOnlyCommand(command)).toBe(true);
	});

	it.each([
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
	])("rejects non-search command %j", (command) => {
		expect(isSearchOnlyCommand(command)).toBe(false);
	});

	it.each([
		["rg 'query'", 25],
		["find . -name '*.ts' | head -n 5", 25],
		["pnpm test", 180],
		["git status && rg 'query'", 180],
	] as const)("defaults the timeout for %s to %s seconds", (command, seconds) => {
		expect(resolveDefaultBashTimeout(command)).toBe(seconds);
	});
});
