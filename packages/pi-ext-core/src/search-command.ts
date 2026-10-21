/** Shared wall-clock budget for find/grep. 0 means unlimited in the FFF engine. */
export const SEARCH_TIMEOUT_MS = 20_000;

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

/**
 * Splits a shell pipeline/command string into tokenized command arrays,
 * preserving quoted strings and splitting on operators (; | & && ||).
 */
export function extractShellCommands(cmd: string): string[][] {
	const tokenRegex = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^\s;'"`|&]+|[;&|]+)/g;
	const commands: string[][] = [];
	let current: string[] = [];
	let match: RegExpExecArray | null = tokenRegex.exec(cmd);
	while (match !== null) {
		const token = match[1];
		if (token === undefined) break;
		if (/^[;&|]+$/.test(token)) {
			if (current.length > 0) {
				commands.push(current);
				current = [];
			}
		} else {
			current.push(token);
		}
		match = tokenRegex.exec(cmd);
	}
	if (current.length > 0) commands.push(current);
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
			let subName: string | undefined;
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
				subName = getBaseName(w);
				break;
			}
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
