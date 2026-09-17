import OpenCC from "opencc-js/t2cn";

interface Fence {
	readonly char: "`" | "~";
	readonly length: number;
}

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

function matchFence(line: string): Fence | undefined {
	const delimiter = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
	if (!delimiter) return undefined;
	return { char: delimiter[0] === "`" ? "`" : "~", length: delimiter.length };
}

function isClosingFence(line: string, active: Fence): boolean {
	const fence = matchFence(line);
	if (fence?.char !== active.char || fence.length < active.length) return false;
	const start = line.search(/[^ ]/u);
	return line.slice(start + fence.length).trim() === "";
}

function proseLine(
	line: string,
	activeDelimiter: number | undefined,
): { readonly text: string; readonly activeDelimiter: number | undefined } {
	let output = "";
	let cursor = 0;
	while (cursor < line.length) {
		const openStart = line.indexOf("`", cursor);
		if (openStart < 0) {
			const tail = line.slice(cursor);
			return {
				text:
					output +
					(activeDelimiter === undefined ? toSimplified(tail).replaceAll("甚么", "什么") : tail),
				activeDelimiter,
			};
		}
		let openEnd = openStart;
		while (openEnd < line.length && line[openEnd] === "`") openEnd++;
		const delimiterLength = openEnd - openStart;
		if (activeDelimiter === undefined) {
			output +=
				toSimplified(line.slice(cursor, openStart)).replaceAll("甚么", "什么") +
				line.slice(openStart, openEnd);
			activeDelimiter = delimiterLength;
		} else {
			output += line.slice(cursor, openEnd);
			if (delimiterLength === activeDelimiter) activeDelimiter = undefined;
		}
		cursor = openEnd;
	}
	return { text: output, activeDelimiter };
}

export function convertInputText(text: string): string {
	let activeFence: Fence | undefined;
	let activeDelimiter: number | undefined;
	return text
		.split("\n")
		.map((line) => {
			const fence = matchFence(line);
			if (activeFence) {
				if (isClosingFence(line, activeFence)) activeFence = undefined;
				return line;
			}
			if (activeDelimiter === undefined && fence) {
				activeFence = fence;
				return line;
			}
			const converted = proseLine(line, activeDelimiter);
			activeDelimiter = converted.activeDelimiter;
			return converted.text;
		})
		.join("\n");
}
