import { SEARCH_TIMEOUT_MS } from "./search-timeout.js";

/** Default timeout for pure search commands run via bash (SEARCH_TIMEOUT_MS + 5s = 25s). */
export const SEARCH_BASH_TIMEOUT_SECONDS = SEARCH_TIMEOUT_MS / 1000 + 5;

const SEARCH_BINARIES = new Set([
	"rg",
	"ripgrep",
	"fd",
	"fdfind",
	"grep",
	"egrep",
	"fgrep",
	"find",
]);

const SEARCH_FILTERS = new Set([
	"head",
	"tail",
	"wc",
	"sort",
	"uniq",
	"cut",
	"awk",
	"sed",
	"tr",
	"less",
	"cat",
	"column",
	"tee",
]);

const WRAPPERS = new Set(["env", "command", "builtin", "nohup", "time"]);

const XARGS_OPTS_WITH_ARG = new Set([
	"-n",
	"-l",
	"-L",
	"-p",
	"-P",
	"-i",
	"-I",
	"-d",
	"-s",
	"-e",
	"-E",
	"-a",
]);

function getBaseName(word: string): string {
	const lastSlash = word.lastIndexOf("/");
	const base = lastSlash >= 0 ? word.slice(lastSlash + 1) : word;
	return base.toLowerCase();
}

function parseXargsTarget(words: readonly string[], startIdx: number): string | undefined {
	let idx = startIdx;
	while (idx < words.length) {
		const w = words[idx];
		if (w === undefined) break;
		if (XARGS_OPTS_WITH_ARG.has(w)) {
			idx += 2;
			continue;
		}
		if (w.startsWith("-")) {
			idx += 1;
			continue;
		}
		return getBaseName(w);
	}
	return undefined;
}

export function extractShellCommands(cmd: string): string[][] {
	const n = cmd.length;
	const commands: string[][] = [];
	let currentCmdWords: string[] = [];
	let currentWord: string[] = [];
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let i = 0;

	while (i < n) {
		const c = cmd[i];
		if (c === undefined) break;
		if (escaped) {
			currentWord.push(c);
			escaped = false;
			i += 1;
			continue;
		}
		if (c === "\\" && !inSingle) {
			escaped = true;
			i += 1;
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			currentWord.push(c);
			i += 1;
			continue;
		}
		if (c === '"' && !inSingle) {
			inDouble = !inDouble;
			currentWord.push(c);
			i += 1;
			continue;
		}

		if (!inSingle && !inDouble) {
			if (c === ";" || c === "\n" || c === "|" || c === "&") {
				if (currentWord.length > 0) {
					currentCmdWords.push(currentWord.join(""));
					currentWord = [];
				}
				if (currentCmdWords.length > 0) {
					commands.push(currentCmdWords);
					currentCmdWords = [];
				}
				if ((c === "|" || c === "&") && i + 1 < n && cmd[i + 1] === c) {
					i += 1;
				}
				i += 1;
				continue;
			}
			if (/\s/.test(c)) {
				if (currentWord.length > 0) {
					currentCmdWords.push(currentWord.join(""));
					currentWord = [];
				}
				i += 1;
				continue;
			}
		}

		currentWord.push(c);
		i += 1;
	}

	if (currentWord.length > 0) {
		currentCmdWords.push(currentWord.join(""));
	}
	if (currentCmdWords.length > 0) {
		commands.push(currentCmdWords);
	}

	return commands;
}

/**
 * Returns true if the command consists only of search commands (rg, fd, grep, find)
 * and optional piping to common filter tools (head, tail, wc, sort, etc.).
 * Disallows commands containing subshell substitutions or non-search utilities.
 */
export function isSearchOnlyCommand(commandStr: string): boolean {
	if (commandStr.includes("$(") || commandStr.includes("`")) return false;
	const commands = extractShellCommands(commandStr);
	if (commands.length === 0) return false;

	let hasSearch = false;
	for (const words of commands) {
		if (words.length === 0) continue;

		let idx = 0;
		let cmdName: string | undefined;
		while (idx < words.length) {
			const w = words[idx];
			if (w === undefined) break;
			// Skip env assignments like FOO=bar
			if (w.includes("=") && !w.startsWith("-") && !w.startsWith("/")) {
				idx += 1;
				continue;
			}
			const base = getBaseName(w);
			if (WRAPPERS.has(base)) {
				idx += 1;
				continue;
			}
			cmdName = base;
			idx += 1;
			break;
		}

		if (cmdName === undefined) return false;

		if (cmdName === "xargs") {
			const subName = parseXargsTarget(words, idx);
			if (subName === undefined) return false;
			if (SEARCH_BINARIES.has(subName)) {
				hasSearch = true;
			} else if (SEARCH_FILTERS.has(subName)) {
				// filter is fine
			} else {
				return false;
			}
		} else if (SEARCH_BINARIES.has(cmdName)) {
			hasSearch = true;
		} else if (SEARCH_FILTERS.has(cmdName)) {
			// filter is fine
		} else {
			return false;
		}
	}

	return hasSearch;
}
