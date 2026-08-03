import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolResultLayout } from "@hheei/pi-ext-core";
import { SelectableReadResult } from "./selectable-read-result.js";

export interface SelectableTextResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}

export interface SelectableTextRenderOptions {
	readonly expanded: boolean;
}

function textOutput(result: SelectableTextResult): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.replace(/\r/g, "")
		.trim();
}

/** Mirrors grep/find visible result rows while excluding UI-only padding and warning chrome. */
export function selectableToolText(
	result: SelectableTextResult,
	options: SelectableTextRenderOptions,
	collapsedLineLimit: number,
): string {
	const output = textOutput(result);
	if (output === "") return "";
	const lines = output.split("\n");
	const visible = options.expanded ? lines : lines.slice(0, collapsedLineLimit);
	return visible.map((line) => line.replace(/[ \t]+$/u, "")).join("\n");
}

/** Adds local selection to Text-based upstream tool results without changing their normal render. */
export class SelectableToolTextResult implements Component {
	private readonly body = new SelectableReadResult();
	private upstream: Component | undefined;
	private offsetY = 0;

	set(args: {
		readonly upstream: Component;
		readonly selectableText: string;
		readonly theme: Theme;
		readonly layout: ToolResultLayout;
		readonly offsetY: number;
	}): void {
		this.upstream = args.upstream;
		this.offsetY = args.offsetY;
		this.body.setResult(args.selectableText, args.theme);
		this.body.bindLayout(args.layout, args.offsetY);
	}

	render(width: number): string[] {
		const upstream = this.upstream;
		if (upstream === undefined) return [];
		const lines = upstream.render(width);
		if (!this.body.hasSelection()) return lines;
		const selected = this.body.render(width);
		return [
			...lines.slice(0, this.offsetY),
			...selected,
			...lines.slice(this.offsetY + selected.length),
		];
	}

	invalidate(): void {
		this.upstream?.invalidate();
	}

	dispose(): void {
		this.body.dispose();
	}
}
