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

export function createExcludeMatcher(
	exclude: string | readonly string[] | undefined,
): (path: string) => boolean {
	const patterns = excludePatterns(exclude);
	if (patterns.length === 0) return () => false;
	const matchers = patterns.map((pattern) => {
		if (pattern.endsWith("/")) {
			return (normalized: string) => normalized.startsWith(pattern);
		}
		const regex = globExpression(pattern);
		return (normalized: string) => regex.test(normalized);
	});
	return (path: string) => {
		const normalized = (path.includes("\\") ? path.replace(/\\/g, "/") : path).replace(/^\.\//, "");
		return matchers.some((matcher) => matcher(normalized));
	};
}

export function filterNativeFindText(
	text: string,
	exclude: string | readonly string[] | undefined,
): string {
	if (exclude === undefined) return text;
	const isExcluded = createExcludeMatcher(exclude);
	const visible = text.split("\n").filter((line) => line && !isExcluded(line));
	return visible.join("\n") || "No files found matching pattern";
}

export function filterNativeGrepText(
	text: string,
	exclude: string | readonly string[] | undefined,
): string {
	if (exclude === undefined) return text;
	const isExcluded = createExcludeMatcher(exclude);
	const visible = text.split("\n").filter((line) => {
		const match = line.match(/^(.*?)(?::|-)(\d+)(?::|-)/);
		return match === null || !isExcluded(match[1] ?? "");
	});
	return visible.join("\n") || "No matches found.";
}

export function isValidRegexPattern(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}
