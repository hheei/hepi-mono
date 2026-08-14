import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

type NativeBodyKind = "after-first-blank" | "trim-leading-blank";

function isBlank(line: string): boolean {
	return stripTerminalSequences(line).trim() === "";
}

function adaptLines(lines: readonly string[], kind: NativeBodyKind): string[] {
	switch (kind) {
		case "after-first-blank": {
			const separator = lines.findIndex(isBlank);
			return separator < 0 ? [] : lines.slice(separator + 1);
		}
		case "trim-leading-blank": {
			let start = 0;
			while (start < lines.length && isBlank(lines[start] ?? "")) start += 1;
			return lines.slice(start);
		}
	}
}

class NativeBodyAdapter implements Component {
	constructor(
		private upstream: Component,
		private readonly kind: NativeBodyKind,
	) {}

	setUpstream(upstream: Component): void {
		this.upstream = upstream;
	}

	inner(): Component {
		return this.upstream;
	}

	matches(kind: NativeBodyKind): boolean {
		return this.kind === kind;
	}

	render(width: number): string[] {
		return adaptLines(this.upstream.render(width), this.kind);
	}

	invalidate(): void {
		this.upstream.invalidate();
	}
}

export function unwrapNativeBody(component: Component | undefined): Component | undefined {
	return component instanceof NativeBodyAdapter ? component.inner() : component;
}

export function adaptNativeBody(
	lastComponent: Component | undefined,
	upstream: Component,
	kind: NativeBodyKind,
): Component {
	if (lastComponent instanceof NativeBodyAdapter && lastComponent.matches(kind)) {
		lastComponent.setUpstream(upstream);
		return lastComponent;
	}
	return new NativeBodyAdapter(upstream, kind);
}
