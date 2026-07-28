/**
 * Native find predicates/actions that the RTK find proxy cannot preserve.
 * Keep this list aligned with RTK's find capability contract.
 */
const UNSUPPORTED_FIND_ARGUMENTS = new Set([
	"-not",
	"!",
	"-or",
	"-o",
	"-and",
	"-a",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-prune",
	"-delete",
	"-print",
	"-print0",
	"-newer",
	"-perm",
	"-size",
	"-mtime",
	"-mmin",
	"-atime",
	"-amin",
	"-ctime",
	"-cmin",
	"-empty",
	"-link",
	"-regex",
	"-iregex",
]);

interface ShellSegment {
	readonly words: ReadonlyArray<string>;
}

function finishWord(words: string[], word: string[]): void {
	if (word.length > 0) {
		words.push(word.join(""));
		word.length = 0;
	}
}

function tokenizeShell(command: string): ReadonlyArray<ShellSegment> {
	const segments: ShellSegment[] = [];
	let words: string[] = [];
	const word: string[] = [];
	let quote: "'" | '"' | null = null;
	let escaped = false;

	const finishSegment = (): void => {
		finishWord(words, word);
		if (words.length > 0) segments.push({ words });
		words = [];
	};

	for (const character of command) {
		if (escaped) {
			word.push(character);
			escaped = false;
			continue;
		}

		if (quote === "'") {
			if (character === "'") quote = null;
			else word.push(character);
			continue;
		}

		if (quote === '"') {
			if (character === '"') quote = null;
			else if (character === "\\") escaped = true;
			else word.push(character);
			continue;
		}

		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			finishWord(words, word);
			continue;
		}
		if (character === ";" || character === "|" || character === "&" || character === "\n") {
			finishSegment();
			continue;
		}
		word.push(character);
	}

	finishSegment();
	return segments;
}

function isAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
}

function basename(command: string): string {
	const slash = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
	return command.slice(slash + 1);
}

function findArguments(segment: ShellSegment): ReadonlyArray<string> | null {
	const words = segment.words;
	let commandIndex = 0;
	while (commandIndex < words.length && isAssignment(words[commandIndex] ?? "")) {
		commandIndex += 1;
	}

	const launcher = words[commandIndex];
	if (launcher === "command" || launcher === "exec") commandIndex += 1;
	while (commandIndex < words.length && isAssignment(words[commandIndex] ?? "")) {
		commandIndex += 1;
	}

	if (basename(words[commandIndex] ?? "") !== "find") return null;
	return words.slice(commandIndex + 1);
}

export function hasUnsupportedFindArguments(command: string): boolean {
	return tokenizeShell(command).some((segment) => {
		const argumentsAfterFind = findArguments(segment);
		return (
			argumentsAfterFind?.some((argument) => UNSUPPORTED_FIND_ARGUMENTS.has(argument)) === true
		);
	});
}

function isRtkFindSegment(segment: ShellSegment): boolean {
	const words = segment.words;
	let commandIndex = 0;
	while (commandIndex < words.length && isAssignment(words[commandIndex] ?? "")) {
		commandIndex += 1;
	}
	return words[commandIndex] === "rtk" && words[commandIndex + 1] === "find";
}

/**
 * RTK's rewrite registry can claim support before `rtk find` validates its
 * native arguments. Preserve the original command for those shapes so native
 * find executes once instead of producing a deterministic retry loop.
 */
export function shouldSkipUnsupportedFindRewrite(
	originalCommand: string,
	rewrittenCommand: string,
): boolean {
	const rewriteTargetsFind = tokenizeShell(rewrittenCommand).some(isRtkFindSegment);
	return rewriteTargetsFind && hasUnsupportedFindArguments(originalCommand);
}
