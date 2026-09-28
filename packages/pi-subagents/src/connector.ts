import { createConnection, type Socket } from "node:net";
import { abortError, errorMessage } from "@hheei/pi-ext-core";
import { toError, writeDiagnostic } from "./diagnostics.js";
import { type ChildIdentity, PROTOCOL_VERSION } from "./domain.js";
import { attachJsonLineReader, writeJsonLine } from "./json-lines.js";
import {
	DEFAULT_MAX_FRAME_BYTES,
	DEFAULT_MAX_PENDING_REQUESTS,
	isEventFrame,
	isHelloAckFrame,
	isResponseFrame,
	type RunnerOperation,
} from "./protocol.js";

/** Bounded memory of locally finished request IDs, used to ignore late responses. */
const MAX_RETIRED_REQUEST_IDS = 256;

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly cleanup: () => void;
}

export interface RunnerConnectionOptions {
	/** Unix socket path published by the runner. */
	readonly endpoint: string;
	readonly identity: ChildIdentity;
	readonly token: string;
	readonly maxFrameBytes?: number;
	readonly maxPendingRequests?: number;
	readonly requestTimeoutMs?: number;
	readonly connectTimeoutMs?: number;
	readonly role?: "controller" | "reporter" | "recovery" | "bridge";
	readonly claimId?: string;
}

/**
 * Parent-side client of the runner IPC endpoint.
 *
 * The connection is re-connectable by design: `close()` only releases this
 * parent's local socket and in-flight requests. It never terminates the runner
 * or the Pi child that the runner owns.
 */
export class RunnerConnection {
	readonly #options: RunnerConnectionOptions;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #retired = new Set<string>();
	readonly #eventListeners = new Set<(event: unknown) => void>();
	#socket: Socket | undefined;
	#detachReader: (() => void) | undefined;
	#nextId = 0;
	#connectPromise: Promise<void> | undefined;

	public constructor(options: RunnerConnectionOptions) {
		this.#options = options;
	}

	public connect(signal?: AbortSignal): Promise<void> {
		if (this.#socket && !this.#socket.destroyed) return Promise.resolve();
		if (this.#connectPromise !== undefined) return this.#connectPromise;
		const promise = this.#open(signal);
		this.#connectPromise = promise;
		void promise
			.finally(() => {
				if (this.#connectPromise === promise) this.#connectPromise = undefined;
			})
			.catch(() => undefined);
		return promise;
	}

	public get connected(): boolean {
		return this.#socket !== undefined && !this.#socket.destroyed;
	}

	public request(
		operation: RunnerOperation,
		payload?: unknown,
		options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
	): Promise<unknown> {
		const socket = this.#socket;
		if (!socket || socket.destroyed) return Promise.reject(new Error("Runner is not connected"));
		if (options.signal?.aborted) return Promise.reject(abortError());
		const limit = this.#options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
		if (this.#pending.size >= limit) {
			return Promise.reject(new Error("Runner pending request limit exceeded"));
		}
		const id = `controller-${++this.#nextId}`;
		// `Promise.withResolvers` needs lib ES2024; this workspace targets ES2022.
		return new Promise((resolve, reject) => {
			const settle = (error: Error | undefined, value?: unknown): void => {
				const pending = this.#pending.get(id);
				if (!pending) return;
				this.#pending.delete(id);
				this.#retire(id);
				pending.cleanup();
				if (error) pending.reject(error);
				else pending.resolve(value);
			};
			const timeout = setTimeout(
				() => settle(new Error(`Runner ${operation} request timed out`)),
				options.timeoutMs ?? this.#options.requestTimeoutMs ?? 30_000,
			);
			const onAbort = (): void => settle(abortError());
			const cleanup = (): void => {
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", onAbort);
			};
			this.#pending.set(id, { resolve, reject, cleanup });
			options.signal?.addEventListener("abort", onAbort, { once: true });
			void writeJsonLine(
				socket,
				{ version: PROTOCOL_VERSION, type: "request", id, operation, payload },
				this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
			).catch((error: unknown) => {
				settle(toError(error));
			});
		});
	}

	public onEvent(listener: (event: unknown) => void): () => void {
		this.#eventListeners.add(listener);
		return () => {
			this.#eventListeners.delete(listener);
		};
	}

	/**
	 * Releases the local socket, reader, listeners and in-flight requests. The
	 * runner keeps running and can be reconnected from the same identity.
	 */
	public close(): void {
		const socket = this.#socket;
		this.#disconnectFor(socket, new Error("Runner connection closed"));
	}

	async #open(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError();
		const socket = createConnection(this.#options.endpoint);
		this.#socket = socket;
		return new Promise((resolve, reject) => {
			let handshakeSettled = false;
			const settleHandshake = (error?: Error): void => {
				if (handshakeSettled) return;
				handshakeSettled = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				if (error === undefined) resolve();
				else {
					this.#disconnectFor(socket, error);
					reject(error);
				}
			};
			const streamError = (error: Error): void => {
				if (!handshakeSettled) settleHandshake(error);
				else if (this.#socket === socket) this.#disconnectFor(socket, error);
			};
			const timeout = setTimeout(
				() => settleHandshake(new Error("Runner connection timed out")),
				this.#options.connectTimeoutMs ?? 10_000,
			);
			const onAbort = (): void => settleHandshake(abortError());
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.on("error", streamError);
			socket.on("close", () => {
				streamError(new Error("Runner disconnected"));
			});
			const detach = attachJsonLineReader(socket, {
				maxFrameBytes: this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
				onError: streamError,
				onValue: (value) => {
					if (!handshakeSettled) {
						if (!isHelloAckFrame(value)) {
							settleHandshake(new Error("Runner sent an invalid handshake response"));
							return;
						}
						settleHandshake();
						return;
					}
					if (this.#socket !== socket) return;
					this.#handleFrame(value);
				},
			});
			this.#detachReader = detach;
			socket.once("connect", () => {
				void writeJsonLine(
					socket,
					{
						version: PROTOCOL_VERSION,
						type: "hello",
						...(this.#options.role === undefined ? {} : { role: this.#options.role }),
						...(this.#options.claimId === undefined ? {} : { claimId: this.#options.claimId }),
						...this.#options.identity,
						token: this.#options.token,
					},
					this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
				).catch((error: unknown) => settleHandshake(toError(error)));
			});
		});
	}

	#handleFrame(value: unknown): void {
		if (isEventFrame(value)) {
			for (const listener of this.#eventListeners) {
				try {
					listener(value.event);
				} catch (error) {
					writeDiagnostic("controller", `event listener failed: ${errorMessage(error)}`);
				}
			}
			return;
		}
		const socket = this.#socket;
		if (!isResponseFrame(value)) {
			this.#disconnectFor(socket, new Error("Runner sent a malformed frame"));
			return;
		}
		const pending = this.#pending.get(value.id);
		if (pending === undefined) {
			if (this.#retired.has(value.id)) return;
			this.#disconnectFor(socket, new Error(`Runner sent unknown response ID: ${value.id}`));
			return;
		}
		this.#pending.delete(value.id);
		this.#retire(value.id);
		pending.cleanup();
		if (value.ok) pending.resolve(value.data);
		else pending.reject(new Error(`${value.error.code}: ${value.error.message}`));
	}

	/** Remembers an ID that finished locally so a late response is ignored. */
	#retire(id: string): void {
		this.#retired.add(id);
		if (this.#retired.size <= MAX_RETIRED_REQUEST_IDS) return;
		const oldest = this.#retired.values().next();
		if (!oldest.done) this.#retired.delete(oldest.value);
	}

	#disconnectFor(socket: Socket | undefined, error: Error): void {
		if (socket !== undefined && this.#socket !== socket) {
			socket.destroy();
			return;
		}
		this.#socket = undefined;
		this.#detachReader?.();
		this.#detachReader = undefined;
		if (socket !== undefined && !socket.destroyed) socket.destroy();
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) {
			entry.cleanup();
			entry.reject(error);
		}
	}
}

/** Sends one child report through a short-lived authenticated reporter connection. */
export async function sendReportToRunner(
	identity: ChildIdentity,
	report: unknown,
	signal?: AbortSignal,
): Promise<void> {
	await sendReporterRequest(identity, "contact_parent", report, signal);
}

/** Sends one child lifecycle event through a short-lived authenticated reporter connection. */
export async function sendLifecycleToRunner(
	identity: ChildIdentity,
	payload: unknown,
	signal?: AbortSignal,
): Promise<void> {
	await sendReporterRequest(identity, "report_lifecycle", payload, signal);
}

/**
 * Sends the task child's final result. A refused result means this execution already submitted
 * one, which the child must not treat as success.
 */
export async function sendTaskResultToRunner(
	identity: ChildIdentity,
	payload: unknown,
	signal?: AbortSignal,
): Promise<void> {
	await sendReporterRequest(identity, "task_result", payload, signal);
}

async function sendReporterRequest(
	identity: ChildIdentity,
	operation: RunnerOperation,
	payload: unknown,
	signal?: AbortSignal,
): Promise<void> {
	const connection = new RunnerConnection({
		endpoint: identity.endpoint,
		identity,
		token: identity.token,
		role: "reporter",
	});
	try {
		await connection.connect(signal);
		await connection.request(operation, payload, signal === undefined ? {} : { signal });
	} finally {
		connection.close();
	}
}

/**
 * Connects to a runner endpoint that may still be starting up.
 *
 * Readiness is never a fixed sleep: each attempt is a real connect plus
 * identity handshake, so a resolved promise means the runner accepted this
 * controller. Only connection-level failures inside the deadline are retried.
 */
export async function connectWithRetry(
	connection: Pick<RunnerConnection, "connect">,
	options: {
		readonly attempts?: number;
		readonly delayMs?: number;
		readonly signal?: AbortSignal;
	} = {},
): Promise<void> {
	const attempts = options.attempts ?? 40;
	const delayMs = options.delayMs ?? 50;
	let lastError: Error = new Error("Runner connection was not attempted");
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (options.signal?.aborted) throw abortError();
		try {
			await connection.connect(options.signal);
			return;
		} catch (error) {
			lastError = toError(error);
			if (lastError.name === "AbortError") throw lastError;
			if (attempt === attempts - 1) break;
			await sleep(delayMs, options.signal);
		}
	}
	throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
