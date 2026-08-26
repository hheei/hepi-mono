import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PtyExitStatus, PtySession } from "./native-bridge.js";

const MAX_LIVE_LINES = 10_000;
const PTY_RUNNING_HINT = "Esc kill/dismiss · input forwarded to PTY";
const PTY_DISMISS_HINT = "Press any key to dismiss";

export type BashPtySurfaceResult =
	| { readonly status: "completed"; readonly exit: PtyExitStatus; readonly output: string }
	| { readonly status: "aborted"; readonly output: string };

/**
 * Fixed-height PTY overlay. Input owns the focused surface; output is bounded
 * locally so an interactive producer cannot retain unbounded session memory.
 */
export class BashPtySurface implements Component {
	readonly #lines: string[] = [];
	#remainder = "";
	#state: "running" | "completed" | "aborted" = "running";
	#exit: PtyExitStatus | undefined;
	#lastRows = 0;
	#lastCols = 0;

	constructor(
		readonly command: string,
		readonly session: PtySession,
		readonly theme: Theme,
		readonly onClose: (result: BashPtySurfaceResult) => void,
	) {}

	append(bytes: Uint8Array, decoder: InstanceType<typeof TextDecoder>): void {
		const text = decoder.decode(bytes, { stream: true }).replaceAll("\u001b", "");
		const parts = `${this.#remainder}${text}`.split("\n");
		this.#remainder = parts.pop() ?? "";
		this.#lines.push(...parts);
		if (this.#lines.length > MAX_LIVE_LINES)
			this.#lines.splice(0, this.#lines.length - MAX_LIVE_LINES);
	}

	complete(exit: PtyExitStatus, decoder: InstanceType<typeof TextDecoder>): void {
		const line = `${this.#remainder}${decoder.decode()}`;
		if (line.length > 0) this.#lines.push(line);
		this.#remainder = "";
		this.#exit = exit;
		this.#state = "completed";
	}

	handleInput(data: string): void {
		if (this.#state === "running" && matchesKey(data, "escape")) {
			this.#state = "aborted";
			this.session.close();
			return;
		}
		if (this.#state === "completed") this.onClose(this.result());
		else if (this.#state === "running") this.session.write(Buffer.from(data, "utf8"));
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const rows = 20;
		const contentRows = rows - 4;
		if (this.#lastCols !== innerWidth || this.#lastRows !== contentRows) {
			this.#lastCols = innerWidth;
			this.#lastRows = contentRows;
			try {
				this.session.resize(contentRows, innerWidth);
			} catch {}
		}
		const border = this.theme.fg("border", "─".repeat(innerWidth));
		const side = this.theme.fg("border", "│");
		const box = (line: string): string =>
			`${side}${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}${side}`;
		const ellipsis = this.theme.fg("dim", "…");
		const header = truncateToWidth(this.theme.fg("bashMode", this.command), innerWidth, ellipsis);
		const output = this.#lines
			.slice(-contentRows)
			.map((line) =>
				truncateToWidth(this.theme.fg("muted", line.replace(/\r/gu, "")), innerWidth, ellipsis),
			);
		while (output.length < contentRows) output.unshift("");
		const footer =
			this.#state === "running"
				? this.theme.fg("dim", PTY_RUNNING_HINT)
				: this.theme.fg(this.#exit?.code === 0 ? "success" : "warning", PTY_DISMISS_HINT);
		return [
			`${this.theme.fg("border", "┌")}${border}${this.theme.fg("border", "┐")}`,
			box(header),
			...output.map(box),
			box(truncateToWidth(footer, innerWidth, ellipsis)),
			`${this.theme.fg("border", "└")}${border}${this.theme.fg("border", "┘")}`,
		];
	}

	invalidate(): void {}
	dispose(): void {
		if (this.#state === "running") this.session.close();
	}

	result(): BashPtySurfaceResult {
		const output = this.#lines.join("\n");
		if (this.#state === "aborted") return { status: "aborted", output };
		const exit = this.#exit;
		if (exit === undefined) return { status: "aborted", output };
		return { status: "completed", exit, output };
	}
}
