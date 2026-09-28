import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { abortError, isRecord } from "@hheei/pi-ext-core";
import { Value } from "typebox/value";
import { toError } from "./diagnostics.js";

import { attachJsonLineReader, serializeJsonLine } from "./json-lines.js";
import {
	DEFAULT_MAX_FRAME_BYTES,
	DEFAULT_MAX_PENDING_REQUESTS,
	GetEntriesPayloadSchema,
	PromptPayloadSchema,
	type RunnerOperation,
} from "./protocol.js";

/**
 * Runner operations that map onto a real Pi `--mode rpc` command. Runner-local
 * shutdown and writer handoff, plus every reporter operation the child bridge sends
 * (contact_parent, report_lifecycle, report_paused, task_result), are never forwarded to Pi.
 */
export type PiRpcOperation = Exclude<
	RunnerOperation,
	| "shutdown"
	| "contact_parent"
	| "report_lifecycle"
	| "report_paused"
	| "task_result"
	| "pause"
	| "cancel_pause"
	| "close_writer"
	| "start_rpc"
>;

/** A forwarded Pi RPC command did not answer within its deadline. */
export class PiRpcTimeoutError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "PiRpcTimeoutError";
	}
}

type PiCommand = Record<string, unknown> & { readonly type: string };

interface PendingRpcRequest {
	readonly command: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly cleanup: () => void;
}

export interface PiRpcAdapterOptions {
	readonly process: ChildProcessWithoutNullStreams;
	readonly maxFrameBytes?: number;
	readonly maxPendingRequests?: number;
	readonly requestTimeoutMs?: number;
	/**
	 * Receives exceptions thrown by event listeners. A listener that throws must
	 * not be mistaken for a malformed Pi frame, so the error is reported here.
	 */
	readonly onListenerError?: (error: unknown) => void;
}

/**
 * Thin request/response transport over one Pi `--mode rpc` child process.
 *
 * Pi stdout is RPC JSON lines only. Responses are matched to in-flight requests
 * by request ID; everything else is delivered to event listeners unchanged.
 */
export class PiRpcAdapter {
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #maxFrameBytes: number;
	readonly #maxPendingRequests: number;
	readonly #requestTimeoutMs: number;
	readonly #onListenerError: (error: unknown) => void;
	readonly #pending = new Map<string, PendingRpcRequest>();
	readonly #listeners = new Set<(event: unknown) => void>();
	#nextRequestId = 0;
	#closedError: Error | undefined;
	#detachReader: (() => void) | undefined;

	public constructor(options: PiRpcAdapterOptions) {
		this.#process = options.process;
		this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
		this.#maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.#onListenerError =
			options.onListenerError ??
			((error: unknown): void => {
				process.stderr.write(
					`pi-subagents rpc listener error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
				);
			});
		const onStreamError = (error: Error): void => this.#fail(error);
		this.#process.stdin.on("error", onStreamError);
		this.#process.stdout.on("error", onStreamError);
		this.#process.once("error", onStreamError);
		this.#process.once("exit", (code, signal) => {
			this.#fail(new Error(`Pi RPC exited (code=${String(code)}, signal=${String(signal)})`));
		});
		this.#detachReader = attachJsonLineReader(this.#process.stdout, {
			maxFrameBytes: this.#maxFrameBytes,
			onValue: (value) => this.#handleValue(value),
			onError: (error) => this.#fail(error),
		});
	}

	public onEvent(listener: (event: unknown) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Confirms readiness with a real `get_state` round trip. */
	public async ready(signal?: AbortSignal): Promise<unknown> {
		return this.request("get_state", undefined, signal === undefined ? {} : { signal });
	}

	public request(
		operation: PiRpcOperation,
		payload?: unknown,
		options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
	): Promise<unknown> {
		let command: PiCommand;
		try {
			command = buildPiCommand(operation, payload);
		} catch (error) {
			return Promise.reject(toError(error));
		}
		return this.#send(command, options);
	}

	public close(reason = new Error("Pi RPC adapter closed")): void {
		this.#fail(reason);
	}

	#send(
		command: PiCommand,
		options: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
	): Promise<unknown> {
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (this.#process.exitCode !== null) {
			return Promise.reject(
				new Error(`Pi RPC process already exited (code=${this.#process.exitCode})`),
			);
		}
		if (options.signal?.aborted) return Promise.reject(abortError());
		if (this.#pending.size >= this.#maxPendingRequests) {
			return Promise.reject(new Error("Pi RPC pending request limit exceeded"));
		}
		const id = `pi-${++this.#nextRequestId}`;
		let encoded: Buffer;
		try {
			encoded = serializeJsonLine({ ...command, id }, this.#maxFrameBytes);
		} catch (error) {
			return Promise.reject(toError(error));
		}
		return new Promise((resolve, reject) => {
			const settle = (error: Error | undefined, value?: unknown): void => {
				const pending = this.#pending.get(id);
				if (!pending) return;
				this.#pending.delete(id);
				pending.cleanup();
				if (error) pending.reject(error);
				else pending.resolve(value);
			};
			const timeout = setTimeout(
				() => settle(new PiRpcTimeoutError(`Pi RPC ${command.type} timed out`)),
				options.timeoutMs ?? this.#requestTimeoutMs,
			);
			const onAbort = (): void => settle(abortError());
			const cleanup = (): void => {
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", onAbort);
			};
			this.#pending.set(id, { command: command.type, resolve, reject, cleanup });
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.#process.stdin.write(encoded, (error?: Error | null) => {
				if (error) settle(error);
			});
		});
	}

	#handleValue(value: unknown): void {
		if (!isRecord(value) || value.type !== "response") {
			for (const listener of this.#listeners) {
				try {
					listener(value);
				} catch (error) {
					this.#onListenerError(error);
				}
			}
			return;
		}
		if (
			typeof value.id !== "string" ||
			typeof value.command !== "string" ||
			typeof value.success !== "boolean" ||
			(value.success === false && typeof value.error !== "string")
		) {
			this.#fail(new Error("Malformed Pi RPC response"));
			return;
		}
		const pending = this.#pending.get(value.id);
		if (!pending) return;
		this.#pending.delete(value.id);
		pending.cleanup();
		if (value.command !== pending.command) {
			pending.reject(new Error(`Pi RPC response command mismatch: expected ${pending.command}`));
			return;
		}
		if (!value.success) {
			pending.reject(new Error(value.error as string));
			return;
		}
		pending.resolve(value.data);
	}

	#fail(error: unknown): void {
		if (this.#closedError) return;
		this.#closedError = toError(error);
		this.#detachReader?.();
		this.#detachReader = undefined;
		const closed = this.#closedError;
		for (const pending of this.#pending.values()) {
			pending.cleanup();
			pending.reject(closed);
		}
		this.#pending.clear();
	}
}

function buildPiCommand(operation: PiRpcOperation, payload: unknown): PiCommand {
	switch (operation) {
		case "prompt":
		case "steer":
		case "follow_up": {
			if (!Value.Check(PromptPayloadSchema, payload)) {
				throw new Error(`${operation} requires a payload with only a non-empty message`);
			}
			return { type: operation, message: payload.message };
		}
		case "get_entries": {
			if (payload === undefined) return { type: operation };
			if (!Value.Check(GetEntriesPayloadSchema, payload)) {
				throw new Error(
					"get_entries payload must be undefined or contain only a non-empty since string",
				);
			}
			return { type: operation, since: payload.since };
		}
		case "abort":
		case "get_state":
		case "get_session_stats":
			if (payload !== undefined) throw new Error(`${operation} does not accept a payload`);
			return { type: operation };
	}
}
