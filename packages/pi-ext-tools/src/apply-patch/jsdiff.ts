import { Worker } from "node:worker_threads";
import type { JsDiffWorkerData } from "./jsdiff-worker.js";
import type { PreparedPatchUpdate, RejectedPatchHunk } from "./outcome.js";
import { compileV4aUpdateToUnifiedDiff } from "./parser.js";

interface RunJsDiffUpdateOptions {
	readonly before: Uint8Array;
	readonly operation: import("./parser.js").V4aUpdateOperation;
	readonly fuzzFactor: number;
	readonly signal?: AbortSignal;
}

const INTERNAL_PATH = "__apply_patch_target__";
const WORKER_URL = new URL(
	import.meta.url.endsWith(".ts") ? "./jsdiff-worker.ts" : "./jsdiff-worker.js",
	import.meta.url,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function parseRejected(value: unknown): RejectedPatchHunk | undefined {
	if (!isRecord(value) || !isFiniteInteger(value.hunkIndex) || value.hunkIndex < 1)
		return undefined;
	if (value.kind === "context_not_found")
		return { kind: "context_not_found", hunkIndex: value.hunkIndex };
	if (value.kind !== "ambiguous_exact" || !Array.isArray(value.candidateStartLines))
		return undefined;
	const candidateStartLines: number[] = [];
	for (const line of value.candidateStartLines) {
		if (!isFiniteInteger(line) || line < 1) return undefined;
		candidateStartLines.push(line);
	}
	return {
		kind: "ambiguous_exact",
		hunkIndex: value.hunkIndex,
		candidateStartLines: Object.freeze(candidateStartLines),
	};
}

function parseStringList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) return undefined;
	return Object.freeze([...value]);
}

function parsePrepared(
	value: unknown,
	expectedHunks: number,
	snapshotPath: string,
): PreparedPatchUpdate | undefined {
	if (
		!isRecord(value) ||
		!(value.after instanceof Uint8Array) ||
		value.after.byteLength > 32 * 1024 * 1024
	)
		return undefined;
	if (value.mode !== undefined && value.mode !== "exact" && value.mode !== "fuzzy")
		return undefined;
	if (
		!isFiniteInteger(value.addedLines) ||
		!isFiniteInteger(value.removedLines) ||
		value.addedLines < 0 ||
		value.removedLines < 0 ||
		!Array.isArray(value.outcomes) ||
		!Array.isArray(value.rejected) ||
		!Array.isArray(value.snapshots)
	)
		return undefined;
	const seen = new Set<number>();
	const outcomes: PreparedPatchUpdate["outcomes"][number][] = [];
	for (const outcome of value.outcomes) {
		if (
			!isRecord(outcome) ||
			outcome.kind !== "applied" ||
			!isFiniteInteger(outcome.hunkIndex) ||
			!isFiniteInteger(outcome.startLine) ||
			!isFiniteInteger(outcome.length) ||
			outcome.hunkIndex < 1 ||
			outcome.hunkIndex > expectedHunks ||
			outcome.startLine < 1 ||
			outcome.length < 0 ||
			(outcome.match !== "exact" && outcome.match !== "fuzzy") ||
			seen.has(outcome.hunkIndex)
		)
			return undefined;
		seen.add(outcome.hunkIndex);
		outcomes.push({
			kind: "applied",
			hunkIndex: outcome.hunkIndex,
			startLine: outcome.startLine,
			length: outcome.length,
			match: outcome.match,
		});
	}
	const rejected: RejectedPatchHunk[] = [];
	for (const item of value.rejected) {
		const parsed = parseRejected(item);
		if (parsed === undefined || parsed.hunkIndex > expectedHunks || seen.has(parsed.hunkIndex))
			return undefined;
		seen.add(parsed.hunkIndex);
		rejected.push(parsed);
	}
	if (seen.size !== expectedHunks) return undefined;
	const snapshots: PreparedPatchUpdate["snapshots"][number][] = [];
	for (const snapshot of value.snapshots) {
		if (!isRecord(snapshot) || snapshot.path !== snapshotPath) return undefined;
		if (
			!isFiniteInteger(snapshot.hunkIndex) ||
			!isFiniteInteger(snapshot.startLine) ||
			!isFiniteInteger(snapshot.afterStartLine) ||
			snapshot.hunkIndex < 1 ||
			snapshot.hunkIndex > expectedHunks ||
			snapshot.startLine < 1 ||
			snapshot.afterStartLine < 1
		)
			return undefined;
		const before = parseStringList(snapshot.before);
		const after = parseStringList(snapshot.after);
		if (before === undefined || after === undefined) return undefined;
		snapshots.push({
			path: snapshot.path,
			hunkIndex: snapshot.hunkIndex,
			startLine: snapshot.startLine,
			afterStartLine: snapshot.afterStartLine,
			before,
			after,
		});
	}
	return {
		after: value.after,
		mode: value.mode,
		addedLines: value.addedLines,
		removedLines: value.removedLines,
		outcomes: Object.freeze(outcomes),
		rejected: Object.freeze(rejected),
		snapshots: Object.freeze(snapshots),
	};
}

export async function runJsDiffUpdate(
	options: RunJsDiffUpdateOptions,
): Promise<PreparedPatchUpdate> {
	options.signal?.throwIfAborted();
	if (options.operation.hunks.length === 0)
		return {
			after: options.before,
			mode: undefined,
			addedLines: 0,
			removedLines: 0,
			outcomes: Object.freeze([]),
			rejected: Object.freeze([]),
			snapshots: Object.freeze([]),
		};
	const workerData: JsDiffWorkerData = {
		before: options.before,
		hunks: options.operation.hunks.map((hunk) => ({
			unifiedDiff: compileV4aUpdateToUnifiedDiff({
				kind: "update",
				path: INTERNAL_PATH,
				hunks: [hunk],
			}),
			hunk,
		})),
		fuzzFactor: options.fuzzFactor,
		snapshotPath: options.operation.moveTo ?? options.operation.path,
	};
	options.signal?.throwIfAborted();
	const worker = new Worker(WORKER_URL, { workerData });
	let settled = false;
	let abortHandler: (() => void) | undefined;
	const cleanup = (): void => {
		if (abortHandler !== undefined) options.signal?.removeEventListener("abort", abortHandler);
		worker.removeAllListeners();
	};
	try {
		return await new Promise<PreparedPatchUpdate>((resolve, reject) => {
			let message: unknown;
			const fail = (error: unknown): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const succeed = (value: PreparedPatchUpdate): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};
			abortHandler = (): void => {
				void worker.terminate().then(
					() => fail(options.signal?.reason ?? new Error("aborted")),
					(error: unknown) => fail(options.signal?.reason ?? error),
				);
			};
			worker.once("message", (value: unknown) => {
				message = value;
			});
			worker.once("error", (error) => fail(error));
			worker.once("exit", (code) => {
				if (settled) return;
				if (options.signal?.aborted) {
					fail(options.signal.reason ?? new Error("aborted"));
					return;
				}
				if (code !== 0 && code !== null) {
					fail(new Error(`jsdiff worker exited with code ${code}`));
					return;
				}
				if (!isRecord(message) || (message.kind !== "result" && message.kind !== "error")) {
					fail(new Error("jsdiff worker returned an invalid result"));
					return;
				}
				if (message.kind === "error") {
					fail(
						new Error(
							typeof message.message === "string" ? message.message : "jsdiff worker failed",
						),
					);
					return;
				}
				const prepared = parsePrepared(
					message.value,
					options.operation.hunks.length,
					options.operation.moveTo ?? options.operation.path,
				);
				if (prepared === undefined) {
					fail(new Error("jsdiff worker returned an invalid result"));
					return;
				}
				succeed(prepared);
			});
			options.signal?.addEventListener("abort", abortHandler, { once: true });
			if (options.signal?.aborted) abortHandler();
		});
	} finally {
		if (!settled) {
			settled = true;
			cleanup();
			await worker.terminate();
		}
	}
}
