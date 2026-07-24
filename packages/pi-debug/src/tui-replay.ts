#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noControlCharactersInRegex: ANSI parser intentionally matches terminal controls.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: ReplayAction switch handles all runtime action variants.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { lock } from "proper-lockfile";

export const DEFAULT_REPLAY_COLUMNS = 50;
export const DEFAULT_REPLAY_ROWS = 35;
export const DEFAULT_REPLAY_MODEL = "cx/gpt-5.6-luna";
export const DEFAULT_REPLAY_THINKING = "low";

export type ReplayThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReplayKey =
	| "up"
	| "down"
	| "left"
	| "right"
	| "enter"
	| "escape"
	| "tab"
	| "shift-tab"
	| "backspace"
	| "delete"
	| "home"
	| "end"
	| "page-up"
	| "page-down";

export interface ReplayModelRequest {
	readonly prompt: string;
	readonly model: string;
	readonly thinking: ReplayThinking;
	readonly cwd?: string;
}

export interface ReplayModelResult extends ReplayModelRequest {
	readonly text: string;
	readonly events: readonly unknown[];
	readonly stderr: string;
}

export type ReplayAction =
	| { readonly type: "input"; readonly data: string; readonly label?: string }
	| { readonly type: "key"; readonly key: ReplayKey; readonly label?: string }
	| { readonly type: "text"; readonly text: string; readonly label?: string }
	| {
			readonly type: "resize";
			readonly columns?: number;
			readonly rows?: number;
			readonly label?: string;
	  }
	| { readonly type: "wait"; readonly ms: number; readonly label?: string }
	| {
			readonly type: "model";
			readonly prompt: string;
			readonly model?: string;
			readonly thinking?: ReplayThinking;
			readonly cwd?: string;
			readonly label?: string;
	  };

export interface ReplayHost {
	requestRender(): void;
	get columns(): number;
	get rows(): number;
	getTerminalRows(): number;
}

export interface ReplayFrame {
	readonly index: number;
	readonly label: string;
	readonly columns: number;
	readonly rows: number;
	readonly renderRequests: number;
	/** ANSI-preserving component output before viewport clipping. */
	readonly lines: readonly string[];
}

export interface TuiReplayResult {
	readonly frames: readonly ReplayFrame[];
	readonly last: ReplayFrame;
	readonly modelResults: readonly ReplayModelResult[];
}

export interface ReplayComponent {
	render(width: number): string[];
	handleInput?(data: string): void | Promise<void>;
	handleModelResult?(result: ReplayModelResult): void | Promise<void>;
	invalidate?(): void;
}

export interface ReplayOptions {
	readonly columns?: number;
	readonly rows?: number;
	readonly actions?: readonly ReplayAction[];
	readonly runModel?: (request: ReplayModelRequest) => Promise<ReplayModelResult>;
	readonly create: (host: ReplayHost) => ReplayComponent;
}

export interface TuiReplaySession {
	apply(action: ReplayAction): Promise<ReplayFrame>;
	result(): TuiReplayResult;
}

export interface FrameViewOptions {
	/** Keep ANSI sequences. Defaults to false. */
	readonly color?: boolean;
	/** Rows above current viewport. Zero means follow bottom. */
	readonly scrollOffset?: number;
	/** Override viewport height. */
	readonly rows?: number;
}

export interface FormatReplayOptions extends FrameViewOptions {
	readonly frames?: "all" | "last";
}

export interface ReplayArtifactOptions {
	readonly rootDir?: string;
	/** Wrap final replay-NNNN publication with a caller-owned transaction guard. */
	readonly publish?: (publish: () => Promise<string>) => Promise<string>;
}

export type ReplaySnapshotFormat = "svg" | "ans";

export interface ReplaySnapshotOptions {
	readonly format: ReplaySnapshotFormat;
	readonly rootDir?: string;
}

export interface TextReplayFrameOptions {
	readonly columns?: number;
	readonly rows?: number;
	readonly label?: string;
}

export interface ReplayArtifacts {
	readonly directory: string;
	readonly replayPlain: string;
	readonly replayAnsi: string;
	readonly finalPlain: string;
	readonly finalAnsi: string;
	readonly finalScreenshot: string;
	readonly metadata: string;
}

const KEY_INPUT: Readonly<Record<ReplayKey, string>> = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	"shift-tab": "\x1b[Z",
	backspace: "\x7f",
	delete: "\x1b[3~",
	home: "\x1b[H",
	end: "\x1b[F",
	"page-up": "\x1b[5~",
	"page-down": "\x1b[6~",
};

export function isReplayKey(value: string): value is ReplayKey {
	return Object.hasOwn(KEY_INPUT, value);
}

function consumeStringControl(value: string, start: number, bellTerminates: boolean): number {
	for (let index = start; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if ((bellTerminates && code === 0x07) || code === 0x9c) return index + 1;
		if (code === 0x1b && value[index + 1] === "\\") return index + 2;
	}
	return value.length;
}

function consumeCsi(
	value: string,
	start: number,
	preserveSgr: boolean,
): { readonly next: number; readonly output: string } {
	for (let index = start; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) {
			const parameters = value.slice(start, index);
			return {
				next: index + 1,
				output:
					preserveSgr && value[index] === "m" && /^[0-9;:]*$/u.test(parameters)
						? `\x1b[${parameters}m`
						: "",
			};
		}
		if (code > 0x7e) return { next: index, output: "" };
	}
	return { next: value.length, output: "" };
}

function sanitizeTerminal(value: string, preserveSgr: boolean): string {
	let output = "";
	for (let index = 0; index < value.length; ) {
		const code = value.charCodeAt(index);
		if (code === 0x1b) {
			const next = value[index + 1];
			if (next === "[") {
				const csi = consumeCsi(value, index + 2, preserveSgr);
				output += csi.output;
				index = csi.next;
			} else if (next === "]") index = consumeStringControl(value, index + 2, true);
			else if (next === "P" || next === "X" || next === "^" || next === "_")
				index = consumeStringControl(value, index + 2, false);
			else index += next === undefined ? 1 : 2;
			continue;
		}
		if (code === 0x9b) {
			const csi = consumeCsi(value, index + 1, preserveSgr);
			output += csi.output;
			index = csi.next;
			continue;
		}
		if (code === 0x9d) {
			index = consumeStringControl(value, index + 1, true);
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
			index = consumeStringControl(value, index + 1, false);
			continue;
		}
		if (code === 0x09 || code === 0x0a) output += value[index];
		else if (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f))
			output += value[index];
		index++;
	}
	return output;
}

export function stripAnsi(value: string): string {
	return sanitizeTerminal(value, false);
}

export function sanitizeAnsi(value: string): string {
	return sanitizeTerminal(value, true);
}

const staticAnsi = sanitizeAnsi;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function assistantOutput(event: unknown): { text?: string; error?: string } | undefined {
	const root = asRecord(event);
	if (root?.type !== "message_end") return undefined;
	const message = asRecord(root.message);
	if (message?.role !== "assistant") return undefined;
	const text = Array.isArray(message.content)
		? message.content
				.flatMap((item) => {
					const content = asRecord(item);
					return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
				})
				.join("")
		: "";
	return {
		...(text ? { text } : {}),
		...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
	};
}

export async function runPiModel(request: ReplayModelRequest): Promise<ReplayModelResult> {
	if (!request.prompt.trim()) throw new Error("model prompt must not be blank");
	if (!request.model.trim()) throw new Error("model must not be blank");
	const subprocess = Bun.spawn(
		[
			"pi",
			"-p",
			"--mode",
			"json",
			"--model",
			request.model,
			"--thinking",
			request.thinking,
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--system-prompt",
			"Respond directly and concisely.",
			request.prompt,
		],
		{ cwd: request.cwd ?? process.cwd(), stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	const events = stdout
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as unknown;
			} catch {
				throw new Error(`Pi emitted invalid JSON: ${line}`);
			}
		});
	let lastError: string | undefined;
	for (let index = events.length - 1; index >= 0; index--) {
		const output = assistantOutput(events[index]);
		if (!output) continue;
		if (output.text) return { ...request, text: output.text, events, stderr };
		lastError ??= output.error;
	}
	throw new Error(lastError ?? (stderr.trim() || `Pi model process exited with code ${exitCode}`));
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`${name} must be a positive integer`);
	return value;
}

function actionLabel(action: ReplayAction): string {
	if (action.label) return action.label;
	switch (action.type) {
		case "input":
			return `input ${JSON.stringify(action.data)}`;
		case "key":
			return `key ${action.key}`;
		case "text":
			return `text ${JSON.stringify(action.text)}`;
		case "resize":
			return `resize ${action.columns ?? "="}x${action.rows ?? "="}`;
		case "wait":
			return `wait ${action.ms}ms`;
		case "model":
			return `model ${action.model ?? DEFAULT_REPLAY_MODEL}: ${JSON.stringify(action.prompt)}`;
	}
}

export function createTuiReplaySession(
	options: Omit<ReplayOptions, "actions">,
): TuiReplaySession {
	let columns = positiveInteger(options.columns ?? DEFAULT_REPLAY_COLUMNS, "columns");
	let rows = positiveInteger(options.rows ?? DEFAULT_REPLAY_ROWS, "rows");
	let renderRequests = 0;
	const host: ReplayHost = {
		requestRender() {
			renderRequests++;
		},
		get columns() {
			return columns;
		},
		get rows() {
			return rows;
		},
		getTerminalRows() {
			return rows;
		},
	};
	const component = options.create(host);
	const frames: ReplayFrame[] = [];
	const modelResults: ReplayModelResult[] = [];
	const capture = (label: string): ReplayFrame => {
		const lines = component.render(columns);
		if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string"))
			throw new Error("TUI component render() must return string[]");
		const frame: ReplayFrame = {
			index: frames.length,
			label,
			columns,
			rows,
			renderRequests,
			lines: [...lines],
		};
		frames.push(frame);
		return frame;
	};

	capture("initial");
	return {
		async apply(action) {
			switch (action.type) {
				case "input":
					await component.handleInput?.(action.data);
					break;
				case "key":
					await component.handleInput?.(KEY_INPUT[action.key]);
					break;
				case "text":
					await component.handleInput?.(action.text);
					break;
				case "resize":
					if (action.columns !== undefined)
						columns = positiveInteger(action.columns, "columns");
					if (action.rows !== undefined) rows = positiveInteger(action.rows, "rows");
					break;
				case "wait":
					if (!Number.isFinite(action.ms) || action.ms < 0)
						throw new Error("wait ms must be non-negative");
					await Bun.sleep(action.ms);
					break;
				case "model": {
					const request: ReplayModelRequest = {
						prompt: action.prompt,
						model: action.model ?? DEFAULT_REPLAY_MODEL,
						thinking: action.thinking ?? DEFAULT_REPLAY_THINKING,
						...(action.cwd === undefined ? {} : { cwd: action.cwd }),
					};
					const modelResult = await (options.runModel ?? runPiModel)(request);
					modelResults.push(modelResult);
					await component.handleModelResult?.(modelResult);
					break;
				}
			}
			return capture(actionLabel(action));
		},
		result() {
			const last = frames.at(-1);
			if (last === undefined) throw new Error("Replay produced no frames");
			return { frames: [...frames], last, modelResults: [...modelResults] };
		},
	};
}

export async function replayTui(options: ReplayOptions): Promise<TuiReplayResult> {
	const session = createTuiReplaySession(options);
	for (const action of options.actions ?? []) await session.apply(action);
	return session.result();
}

function outputLines(frame: ReplayFrame, color: boolean): readonly string[] {
	return color ? frame.lines : frame.lines.map(stripAnsi);
}

export function viewFrame(frame: ReplayFrame, options: FrameViewOptions = {}): readonly string[] {
	const lines = outputLines(frame, options.color ?? false);
	const rows = positiveInteger(options.rows ?? frame.rows, "rows");
	const maxOffset = Math.max(0, lines.length - rows);
	const offset = Math.min(maxOffset, Math.max(0, Math.floor(options.scrollOffset ?? 0)));
	const end = Math.max(0, lines.length - offset);
	return lines.slice(Math.max(0, end - rows), end);
}

export function scrollbackLines(frame: ReplayFrame, color = false): readonly string[] {
	const lines = outputLines(frame, color);
	return lines.slice(0, Math.max(0, lines.length - frame.rows));
}

export function createTextReplayFrame(
	text: string,
	options: TextReplayFrameOptions = {},
): ReplayFrame {
	const lines = text
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.map(staticAnsi);
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	const naturalColumns = Math.max(1, ...lines.map((line) => visibleWidth(line)));
	const columns = positiveInteger(options.columns ?? naturalColumns, "columns");
	const fitted = lines.map((line) => truncateToWidth(line, columns, ""));
	return {
		index: 0,
		label: options.label ?? "text capture",
		columns,
		rows: positiveInteger(options.rows ?? Math.max(1, fitted.length), "rows"),
		renderRequests: 0,
		lines: fitted,
	};
}

export function formatReplay(result: TuiReplayResult, options: FormatReplayOptions = {}): string {
	const frames = options.frames === "last" ? [result.last] : result.frames;
	return frames
		.map((frame) => {
			const body = viewFrame(frame, options).join("\n");
			return `--- #${frame.index} ${frame.label} (${frame.columns}x${frame.rows}, renders=${frame.renderRequests}) ---\n${body}`;
		})
		.join("\n\n");
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const LEGACY_REPLAY_DIRECTORY = /^replay-\d{17}(?:-\d+)?$/u;
const REPLAY_DIRECTORY = /^replay-(\d{4,})$/u;

async function withArtifactRootLock<T>(rootDir: string, run: () => Promise<T>): Promise<T> {
	await mkdir(rootDir, { recursive: true });
	const release = await lock(join(rootDir, ".replay-publish"), {
		realpath: false,
		stale: 60_000,
		update: 10_000,
		retries: { retries: 100, minTimeout: 10, maxTimeout: 1_000 },
	});
	try {
		return await run();
	} finally {
		await release();
	}
}

async function nextArtifactId(rootDir: string): Promise<bigint> {
	let nextId = 1n;
	for (const name of await readdir(rootDir)) {
		if (LEGACY_REPLAY_DIRECTORY.test(name)) continue;
		const match = REPLAY_DIRECTORY.exec(name);
		const value = match?.[1];
		if (value === undefined) continue;
		const candidate = BigInt(value) + 1n;
		if (candidate > nextId) nextId = candidate;
	}
	return nextId;
}

async function publishArtifactDirectory(rootDir: string, temporary: string): Promise<string> {
	return await withArtifactRootLock(rootDir, async () => {
		let nextId = await nextArtifactId(rootDir);
		for (;;) {
			const directory = join(rootDir, `replay-${nextId.toString().padStart(4, "0")}`);
			try {
				await rename(temporary, directory);
				return directory;
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
				nextId += 1n;
			}
		}
	});
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

interface AnsiSvgStyle {
	color: string;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
}

const ANSI_COLORS = [
	"#0c0c0c",
	"#c50f1f",
	"#13a10e",
	"#c19c00",
	"#0037da",
	"#881798",
	"#3a96dd",
	"#cccccc",
	"#767676",
	"#e74856",
	"#16c60c",
	"#f9f1a5",
	"#3b78ff",
	"#b4009e",
	"#61d6d6",
	"#f2f2f2",
] as const;
const SGR = /\x1b\[([0-9;:]*)m/gu;

function ansiColor(index: number): string {
	if (index < 16) return ANSI_COLORS[index] ?? "#d8dee9";
	if (index < 232) {
		const value = index - 16;
		const channel = (part: number) => (part === 0 ? 0 : 55 + part * 40);
		const red = channel(Math.floor(value / 36));
		const green = channel(Math.floor((value % 36) / 6));
		const blue = channel(value % 6);
		return `rgb(${red},${green},${blue})`;
	}
	const gray = 8 + Math.min(23, index - 232) * 10;
	return `rgb(${gray},${gray},${gray})`;
}

function resetAnsiStyle(style: AnsiSvgStyle): void {
	style.color = "#d8dee9";
	style.bold = false;
	style.dim = false;
	style.italic = false;
	style.underline = false;
	style.strike = false;
}

function applySgr(style: AnsiSvgStyle, value: string): void {
	const codes = (value || "0").replaceAll(":", ";").split(";").map(Number);
	for (let index = 0; index < codes.length; index++) {
		const code = codes[index] ?? 0;
		if (code === 0) resetAnsiStyle(style);
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 9) style.strike = true;
		else if (code === 22) {
			style.bold = false;
			style.dim = false;
		} else if (code === 23) style.italic = false;
		else if (code === 24) style.underline = false;
		else if (code === 29) style.strike = false;
		else if (code >= 30 && code <= 37) style.color = ansiColor(code - 30);
		else if (code >= 90 && code <= 97) style.color = ansiColor(code - 90 + 8);
		else if (code === 39) style.color = "#d8dee9";
		else if (code === 38 && codes[index + 1] === 5 && codes[index + 2] !== undefined) {
			const colorIndex = codes[index + 2];
			if (colorIndex === undefined) continue;
			style.color = ansiColor(Math.max(0, Math.min(255, colorIndex)));
			index += 2;
		} else if (
			code === 38 &&
			codes[index + 1] === 2 &&
			codes[index + 2] !== undefined &&
			codes[index + 3] !== undefined &&
			codes[index + 4] !== undefined
		) {
			style.color = `rgb(${codes[index + 2]},${codes[index + 3]},${codes[index + 4]})`;
			index += 4;
		}
	}
}

function ansiSvgLine(line: string, style: AnsiSvgStyle): string {
	const spans: string[] = [];
	let offset = 0;
	const append = (text: string) => {
		const plain = stripAnsi(text);
		if (!plain) return;
		const decorations = [style.underline ? "underline" : "", style.strike ? "line-through" : ""]
			.filter(Boolean)
			.join(" ");
		const attributes = [
			`fill="${style.color}"`,
			...(style.bold ? ['font-weight="700"'] : []),
			...(style.dim ? ['opacity="0.65"'] : []),
			...(style.italic ? ['font-style="italic"'] : []),
			...(decorations ? [`text-decoration="${decorations}"`] : []),
		].join(" ");
		spans.push(`<tspan ${attributes}>${escapeXml(plain)}</tspan>`);
	};
	for (const match of line.matchAll(SGR)) {
		append(line.slice(offset, match.index));
		applySgr(style, match[1] ?? "");
		offset = match.index + match[0].length;
	}
	append(line.slice(offset));
	return spans.join("");
}

export function finalFrameSvg(frame: ReplayFrame): string {
	const cellWidth = 8.4;
	const lineHeight = 18;
	const padding = 12;
	const lines = [...viewFrame(frame, { color: true })].map(staticAnsi);
	const style: AnsiSvgStyle = {
		color: "#d8dee9",
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		strike: false,
	};
	while (lines.length < frame.rows) lines.push("");
	const width = Math.ceil(frame.columns * cellWidth + padding * 2);
	const height = frame.rows * lineHeight + padding * 2;
	const content = lines
		.slice(0, frame.rows)
		.map(
			(line, index) =>
				`  <text x="${padding}" y="${padding + 14 + index * lineHeight}" xml:space="preserve">${ansiSvgLine(line, style)}</text>`,
		)
		.join("\n");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0b0f14"/>
  <g font-family="Menlo, Monaco, 'Courier New', monospace" font-size="14">
${content}
  </g>
</svg>
`;
}

export function finalFrameAnsi(frame: ReplayFrame): string {
	return `${staticAnsi(viewFrame(frame, { color: true }).join("\n"))}\x1b[0m\n`;
}

export async function writeReplaySnapshot(
	frame: ReplayFrame,
	options: ReplaySnapshotOptions,
): Promise<string> {
	const extension = options.format;
	const content = options.format === "svg" ? finalFrameSvg(frame) : finalFrameAnsi(frame);
	const rootDir = options.rootDir ?? join(process.cwd(), "outputs");
	await mkdir(rootDir, { recursive: true });
	const temporary = join(rootDir, `.replay-${randomUUID()}.tmp`);
	await mkdir(temporary);
	try {
		await writeFile(join(temporary, `final.${extension}`), content, "utf8");
		const directory = await publishArtifactDirectory(rootDir, temporary);
		return join(directory, `final.${extension}`);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
}

function replayArtifacts(directory: string): ReplayArtifacts {
	return {
		directory,
		replayPlain: join(directory, "replay.txt"),
		replayAnsi: join(directory, "replay.ans"),
		finalPlain: join(directory, "final.txt"),
		finalAnsi: join(directory, "final.ans"),
		finalScreenshot: join(directory, "final.svg"),
		metadata: join(directory, "metadata.json"),
	};
}

export async function writeReplayArtifacts(
	result: TuiReplayResult,
	options: ReplayArtifactOptions = {},
): Promise<ReplayArtifacts> {
	const now = new Date();
	const replayPlain = `${formatReplay(result)}\n`;
	const replayAnsi = `${staticAnsi(formatReplay(result, { color: true }))}\x1b[0m\n`;
	const finalPlain = `${viewFrame(result.last).join("\n")}\n`;
	const finalAnsi = finalFrameAnsi(result.last);
	const finalScreenshot = finalFrameSvg(result.last);
	const metadata = `${JSON.stringify(
		{
			createdAt: now.toISOString(),
			buffer: "component.render viewport",
			columns: result.last.columns,
			rows: result.last.rows,
			frames: result.frames.map(({ index, label, renderRequests }) => ({
				index,
				label,
				renderRequests,
			})),
			modelCalls: result.modelResults.map(({ model, thinking }) => ({ model, thinking })),
		},
		null,
		2,
	)}\n`;
	const rootDir = options.rootDir ?? join(process.cwd(), "outputs");
	await mkdir(rootDir, { recursive: true });
	const temporary = join(rootDir, `.replay-${randomUUID()}.tmp`);
	await mkdir(temporary);
	const pending = replayArtifacts(temporary);
	try {
		const writes = await Promise.allSettled([
			writeFile(pending.replayPlain, replayPlain, "utf8"),
			writeFile(pending.replayAnsi, replayAnsi, "utf8"),
			writeFile(pending.finalPlain, finalPlain, "utf8"),
			writeFile(pending.finalAnsi, finalAnsi, "utf8"),
			writeFile(pending.finalScreenshot, finalScreenshot, "utf8"),
			writeFile(pending.metadata, metadata, "utf8"),
		]);
		const failed = writes.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		const publish = async (): Promise<string> =>
			await publishArtifactDirectory(rootDir, temporary);
		const directory =
			options.publish === undefined ? await publish() : await options.publish(publish);
		return replayArtifacts(directory);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
}

export function parseReplayThinking(value: string | undefined): ReplayThinking {
	switch (value) {
		case undefined:
			return DEFAULT_REPLAY_THINKING;
		case "off":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return value;
		default:
			throw new Error(`Unsupported thinking level: ${value}`);
	}
}

function singleCliValue(values: readonly string[] | undefined, name: string): string | undefined {
	if (values !== undefined && values.length > 1)
		throw new Error(`${name} may be provided only once`);
	return values?.[0];
}

async function captureShellCommand(
	command: string,
): Promise<{ readonly text: string; readonly exitCode: number }> {
	const subprocess = Bun.spawn(["/bin/sh", "-lc", command], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	const separator = stdout !== "" && stderr !== "" && !stdout.endsWith("\n") ? "\n" : "";
	return { text: `${stdout}${separator}${stderr}`, exitCode };
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: false,
		strict: true,
		options: {
			help: { type: "boolean", short: "h" },
			command: { type: "string", multiple: true },
			text: { type: "string", multiple: true },
			format: { type: "string", multiple: true },
			columns: { type: "string", multiple: true },
			rows: { type: "string", multiple: true },
			prompt: { type: "string", multiple: true },
			model: { type: "string", multiple: true },
			thinking: { type: "string", multiple: true },
		},
	});
	if (values.help) {
		console.log(`Usage:
  pi-tui-replay --command "git status --short" [--format svg|ans] [--columns N] [--rows N]
  pi-tui-replay --text "literal output" [--text "next line"] [--format svg|ans]
  pi-tui-replay
  pi-tui-replay --prompt "Prompt sent to the real model"
  pi-tui-replay --prompt "First" --prompt "Second" [--model cx/gpt-5.6-luna] [--thinking low] [--columns 50] [--rows 35]

--command and --text create a non-interactive shell-text snapshot. The default format is svg.
Snapshots use outputs/replay-<ID>/final.<format>.
Without capture or prompt options, runs a local two-round component demo.
Every component replay writes a complete bundle under outputs/replay-<ID>/.`);
		process.exit(0);
	}
	const textValues = values.text ?? [];
	const command = singleCliValue(values.command, "--command");
	const promptValues = values.prompt ?? [];
	const rawFormat = singleCliValue(values.format, "--format");
	const rawColumns = singleCliValue(values.columns, "--columns");
	const rawRows = singleCliValue(values.rows, "--rows");
	const rawModel = singleCliValue(values.model, "--model");
	const rawThinking = singleCliValue(values.thinking, "--thinking");
	if (command !== undefined && command.trim() === "") throw new Error("--command must not be blank");
	if (command !== undefined && textValues.length > 0)
		throw new Error("--command and --text cannot be combined");
	if ((command !== undefined || textValues.length > 0) && promptValues.length > 0)
		throw new Error("shell/text capture cannot be combined with --prompt");
	if (command !== undefined || textValues.length > 0) {
		if (rawModel !== undefined || rawThinking !== undefined)
			throw new Error("shell/text capture cannot use --model or --thinking");
		let format: ReplaySnapshotFormat;
		if (rawFormat === undefined || rawFormat === "svg") format = "svg";
		else if (rawFormat === "ans") format = "ans";
		else throw new Error(`Unsupported snapshot format: ${rawFormat}`);
		const capture =
			command === undefined
				? { text: textValues.join("\n"), exitCode: 0 }
				: await captureShellCommand(command);
		const frame = createTextReplayFrame(capture.text, {
			...(rawColumns === undefined
				? {}
				: { columns: positiveInteger(Number(rawColumns), "columns") }),
			...(rawRows === undefined ? {} : { rows: positiveInteger(Number(rawRows), "rows") }),
		});
		const outputPath = await writeReplaySnapshot(frame, { format });
		console.log(stripAnsi(outputPath));
		if (capture.exitCode !== 0) process.exit(capture.exitCode);
		process.exit(0);
	}
	if (rawFormat !== undefined) throw new Error("--format requires --command or --text");
	if (promptValues.length === 0 && (rawModel !== undefined || rawThinking !== undefined))
		throw new Error("--model and --thinking require --prompt");
	const columns = positiveInteger(
		Number(rawColumns ?? String(DEFAULT_REPLAY_COLUMNS)),
		"columns",
	);
	const rows = positiveInteger(Number(rawRows ?? String(DEFAULT_REPLAY_ROWS)), "rows");
	const model = rawModel ?? DEFAULT_REPLAY_MODEL;
	const thinking = parseReplayThinking(rawThinking);
	const prompts = promptValues;
	const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
	const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
	let draft = "";
	const messages = [
		prompts.length > 0 ? `System: live model ${model} (${thinking})` : "System: local replay ready",
	];
	const actions: ReplayAction[] =
		prompts.length > 0
			? prompts.flatMap((prompt, index) => [
					{ type: "text", text: prompt, label: `round ${index + 1} input` },
					{ type: "key", key: "enter", label: `round ${index + 1} submit` },
					{ type: "model", prompt, model, thinking, label: `round ${index + 1} model` },
				])
			: [
					{ type: "text", text: "first answer", label: "round 1 input" },
					{ type: "key", key: "enter", label: "round 1 submit" },
					{ type: "text", text: "second answer", label: "round 2 input" },
					{ type: "key", key: "enter", label: "round 2 submit" },
				];
	const result = await replayTui({
		columns,
		rows,
		create: (host) => ({
			render: () => [
				cyan(`TUI replay · ${host.columns}x${host.rows}`),
				...messages.map((message) => green(message)),
				`> ${draft}`,
			],
			handleInput(data) {
				if (data === "\r") {
					messages.push(`User: ${draft}`);
					if (prompts.length === 0) messages.push(`Assistant: round ${messages.length / 2}`);
					draft = "";
				} else {
					draft += data;
				}
				host.requestRender();
			},
			handleModelResult(modelResult) {
				messages.push(`Assistant: ${modelResult.text}`);
				host.requestRender();
			},
			invalidate() {},
		}),
		actions,
	});
	const artifacts = await writeReplayArtifacts(result);

	console.log("ANSI viewport:\n");
	process.stdout.write(finalFrameAnsi(result.last));
	console.log("\nPlain viewport:\n");
	console.log(viewFrame(result.last).join("\n"));
	console.log("\nPlain scrollback:\n");
	console.log(scrollbackLines(result.last).join("\n") || "(empty)");
	console.log("\nScrolled up two rows:\n");
	console.log(viewFrame(result.last, { scrollOffset: 2 }).join("\n"));
	console.log("\nMulti-round replay:\n");
	console.log(formatReplay(result));
	console.log(`\nArtifacts:\n${stripAnsi(artifacts.directory)}`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		const message = stripAnsi(
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
