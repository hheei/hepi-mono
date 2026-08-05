import { isAbsolute, relative } from "node:path";

const GLOB_SYNTAX = /[*?[{]/;

function normalizePathConstraint(path: string, cwd: string): string | null {
	let value = path.trim();
	if (!value || value === "." || value === "./" || value === "**" || value === "**/") return null;
	if (isAbsolute(value)) {
		const relativePath = relative(cwd, value).replace(/\\/g, "/");
		if (relativePath === "" || relativePath.startsWith("../") || relativePath === "..") return null;
		value = relativePath;
	}
	if (value.startsWith("../")) return null;
	if (value.startsWith("./")) value = value.slice(2);
	if (value.startsWith("/") || value.endsWith("/") || GLOB_SYNTAX.test(value)) return value;
	const basename = value.split("/").pop() ?? "";
	return /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(basename) ? value : `${value}/`;
}

export function supportsFffPath(path: string | undefined, cwd: string): boolean {
	return path === undefined || normalizePathConstraint(path, cwd) !== null;
}

export function buildFffQuery(
	path: string | undefined,
	pattern: string,
	exclude: string | readonly string[] | undefined,
	cwd: string,
): string {
	const parts: string[] = [];
	if (path !== undefined) {
		const constraint = normalizePathConstraint(path, cwd);
		if (constraint !== null) parts.push(constraint);
	}
	const excludes = exclude === undefined ? [] : Array.isArray(exclude) ? exclude : [exclude];
	for (const excludePath of excludes) {
		for (const part of excludePath.split(/[\s,]+/)) {
			const constraint = normalizePathConstraint(part.replace(/^!/, ""), cwd);
			if (constraint !== null) parts.push(`!${constraint}`);
		}
	}
	parts.push(pattern);
	return parts.join(" ");
}

export function containsRegexSyntax(pattern: string): boolean {
	return /[.*+?^${}()|[\]\\]/.test(pattern);
}

export function nativeFallbackPattern(pattern: string): string {
	const words = pattern.trim().split(/\s+/).filter(Boolean);
	return words.length === 0 ? "*" : `*${words.join("*")}*`;
}

function excludePatterns(exclude: string | readonly string[] | undefined): string[] {
	const values = exclude === undefined ? [] : Array.isArray(exclude) ? exclude : [exclude];
	return values
		.flatMap((value) => value.split(/[\s,]+/))
		.map((value) => value.trim().replace(/^!/, "").replace(/^\.\//, ""))
		.filter((value) => value.length > 0);
}

function globExpression(pattern: string): RegExp {
	let expression = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index] ?? "";
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				if (pattern[index + 1] === "/") {
					index += 1;
					expression += "(?:.*/)?";
				} else expression += ".*";
			} else expression += "[^/]*";
			continue;
		}
		if (character === "?") {
			expression += "[^/]";
			continue;
		}
		expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`${expression}$`);
}

export function isExcludedPath(
	path: string,
	exclude: string | readonly string[] | undefined,
): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
	return excludePatterns(exclude).some((pattern) => {
		if (pattern.endsWith("/")) return normalized.startsWith(pattern);
		return globExpression(pattern).test(normalized);
	});
}

export function filterNativeFindText(
	text: string,
	exclude: string | readonly string[] | undefined,
): string {
	if (exclude === undefined) return text;
	const visible = text.split("\n").filter((line) => line && !isExcludedPath(line, exclude));
	return visible.join("\n") || "No files found matching pattern";
}

export function filterNativeGrepText(
	text: string,
	exclude: string | readonly string[] | undefined,
): string {
	if (exclude === undefined) return text;
	const visible = text.split("\n").filter((line) => {
		const match = line.match(/^(.*?)(?::|-)(\d+)(?::|-)/);
		return match === null || !isExcludedPath(match[1] ?? "", exclude);
	});
	return visible.join("\n") || "No matches found.";
}
