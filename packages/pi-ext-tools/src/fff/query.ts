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
