import type { Theme, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { SelectableReadResult } from "./selectable-read-result.js";

/**
 * Preserves upstream bash rendering until selection exists. During selection it
 * swaps only its leading output rows, leaving truncation warnings and elapsed
 * time rows rendered by upstream intact.
 */
export class SelectableBashResult implements Component {
	private readonly body = new SelectableReadResult();
	private upstream: Component | undefined;

	set(upstream: Component, output: string, theme: Theme, context: ToolRenderContext): void {
		this.upstream = upstream;
		this.body.setResult(output, theme);
		this.body.bindLayout(context, 1);
	}

	render(width: number): string[] {
		const upstream = this.upstream;
		if (upstream === undefined) return [];
		const lines = upstream.render(width);
		if (!this.body.hasSelection()) return lines;
		const selected = this.body.render(width);
		return [...lines.slice(0, 1), ...selected, ...lines.slice(1 + selected.length)];
	}

	invalidate(): void {
		this.upstream?.invalidate();
	}

	dispose(): void {
		this.body.dispose();
	}
}
