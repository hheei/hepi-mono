import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "@hheei/pi-ext-core";
import {
	holdProcessLock,
	type ProcessLock,
	processLockHeld,
	processLockPath,
} from "./process-lock.js";
import { BridgeError, DEFAULT_MAX_BUFFERED_EVENTS } from "./protocol.js";
import {
	claimCommand,
	claimParentCommands,
	deleteCommand,
	deleteSettledCommands,
	enqueueCommand,
	finishCommand,
	hasPendingCommand,
	openStateDb,
	readCommand,
	requeueAbandonedParentCommands,
	type StoredCommand,
	trimEventBacklog,
	withWrite,
} from "./state-db.js";

const DEFAULT_POLL_MS = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface MailboxRequest {
	readonly childId: string;
	readonly operation: string;
	readonly payload: unknown;
}

export interface MailboxTransport {
	readonly endpoint: string;
	isConnected(childId: string): boolean;
	disconnect(childId: string): void;
	request(
		childId: string,
		operation: string,
		payload?: unknown,
		options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
	): Promise<unknown>;
	onEvent(listener: (childId: string, event: unknown) => void): () => void;
	onConnectionChange(listener: (childId: string, connected: boolean) => void): () => void;
	waitUntilSeen(
		childId: string,
		options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
	): Promise<boolean>;
	close(): void;
}

export function createMailboxTransport(options: {
	readonly filePath: string;
	readonly parentSessionId: string;
	readonly handleRequest: (request: MailboxRequest) => Promise<unknown>;
	readonly pollMs?: number;
	readonly diagnose?: (message: string) => void;
}): MailboxTransport {
	const db = openStateDb(options.filePath);
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const seen = new Set<string>();
	const eventListeners = new Set<(childId: string, event: unknown) => void>();
	const connectionListeners = new Set<(childId: string, connected: boolean) => void>();
	/** One lifetime per transport: closing it settles every request still waiting on a reply. */
	const lifetime = new AbortController();
	let closed = false;
	let polling = false;

	const emitConnection = (childId: string, connected: boolean): void => {
		for (const listener of [...connectionListeners]) {
			try {
				listener(childId, connected);
			} catch (error) {
				options.diagnose?.(`connection listener failed: ${errorMessage(error)}`);
			}
		}
	};

	const lockHeld = (childId: string): boolean | undefined => {
		const lockPath = processLockPath(options.filePath, options.parentSessionId, childId);
		if (lockPath === undefined) return false;
		try {
			return processLockHeld(lockPath);
		} catch (error) {
			options.diagnose?.(`could not probe the process lock for ${childId}: ${errorMessage(error)}`);
			return undefined;
		}
	};

	const noticeLocks = (): void => {
		if (closed) return;
		const directory = join(dirname(options.filePath), "locks", options.parentSessionId);
		let names: string[] = [];
		try {
			names = readdirSync(directory);
		} catch (error) {
			const missing =
				typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			if (!missing) {
				options.diagnose?.(`could not read process locks: ${errorMessage(error)}`);
				return;
			}
		}
		const heldNow = new Set<string>();
		for (const name of names) {
			if (!name.endsWith(".lock")) continue;
			const childId = name.slice(0, -".lock".length);
			const held = lockHeld(childId);
			if (held === true || (held === undefined && seen.has(childId))) heldNow.add(childId);
		}
		for (const childId of heldNow) {
			if (seen.has(childId)) continue;
			seen.add(childId);
			emitConnection(childId, true);
		}
		for (const childId of [...seen]) {
			if (heldNow.has(childId)) continue;
			seen.delete(childId);
			emitConnection(childId, false);
		}
	};

	const takeParentCommands = async (): Promise<void> => {
		if (closed || polling) return;
		polling = true;
		try {
			noticeLocks();
			// Empty is the common tick. A read sees it; claiming would take a write lock and fsync.
			if (!hasPendingCommand(db, options.parentSessionId, "to_parent")) return;
			const claimed = withWrite(db, () => claimParentCommands(db, options.parentSessionId));
			const eventIds: string[] = [];
			const dropEvents = (): void => {
				if (eventIds.length === 0) return;
				const ids = eventIds.splice(0);
				withWrite(db, () => {
					for (const id of ids) deleteCommand(db, id);
				});
			};
			for (const command of claimed) {
				if (!seen.has(command.subagentId) && lockHeld(command.subagentId) === true) {
					seen.add(command.subagentId);
					emitConnection(command.subagentId, true);
				}
				if (command.operation === "event") {
					let event: unknown = command.payload;
					try {
						event = JSON.parse(command.payload) as unknown;
					} catch {
						event = command.payload;
					}
					for (const listener of [...eventListeners]) {
						try {
							listener(command.subagentId, event);
						} catch (error) {
							options.diagnose?.(`event listener failed: ${errorMessage(error)}`);
						}
					}
					eventIds.push(command.id);
					continue;
				}
				dropEvents();
				try {
					const payload = JSON.parse(command.payload) as unknown;
					const result = await options.handleRequest({
						childId: command.subagentId,
						operation: command.operation,
						payload,
					});
					finishCommand(db, command.id, { status: "done", result: JSON.stringify(result ?? null) });
				} catch (error) {
					const bridge = error instanceof BridgeError ? error : undefined;
					finishCommand(db, command.id, {
						status: "failed",
						errorCode: bridge?.code ?? "request_failed",
						error: bridge?.message ?? errorMessage(error),
					});
				}
			}
			dropEvents();
		} finally {
			polling = false;
		}
	};

	withWrite(db, () => {
		requeueAbandonedParentCommands(db, options.parentSessionId);
		deleteSettledCommands(db, options.parentSessionId);
	});

	const timer = setInterval(() => {
		void takeParentCommands().catch((error: unknown) => {
			options.diagnose?.(`could not take parent commands: ${errorMessage(error)}`);
		});
	}, pollMs);
	timer.unref?.();

	return {
		endpoint: options.filePath,
		isConnected(childId) {
			return lockHeld(childId) !== false;
		},
		disconnect(childId) {
			if (lockHeld(childId) !== false) return;
			if (seen.delete(childId)) emitConnection(childId, false);
		},
		async request(childId, operation, payload, requestOptions) {
			const id = randomUUID();
			enqueueCommand(db, {
				id,
				parentSessionId: options.parentSessionId,
				subagentId: childId,
				direction: "to_child",
				operation,
				payload: JSON.stringify(payload ?? null),
				createdAt: Date.now(),
			});
			return waitForCommand(db, id, {
				timeoutMs: requestOptions?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
				pollMs,
				signal: untilClosed(requestOptions?.signal, lifetime.signal),
				...(options.diagnose === undefined ? {} : { diagnose: options.diagnose }),
			});
		},
		onEvent(listener) {
			eventListeners.add(listener);
			return () => {
				eventListeners.delete(listener);
			};
		},
		onConnectionChange(listener) {
			connectionListeners.add(listener);
			return () => {
				connectionListeners.delete(listener);
			};
		},
		async waitUntilSeen(childId, waitOptions) {
			const timeoutMs = waitOptions?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
			const started = Date.now();
			while (Date.now() - started < timeoutMs) {
				if (waitOptions?.signal?.aborted) return false;
				if (lockHeld(childId) === true) {
					if (!seen.has(childId)) {
						seen.add(childId);
						emitConnection(childId, true);
					}
					return true;
				}
				await delay(pollMs);
			}
			return false;
		},
		close() {
			closed = true;
			clearInterval(timer);
			lifetime.abort(new BridgeError("closed", "The mailbox transport was closed"));
		},
	};
}

export interface ChildMailbox {
	readonly connected: boolean;
	start(): void;
	report(operation: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
	sendEvent(event: unknown): void;
	close(): void;
}

export function attachChildMailbox(options: {
	readonly filePath: string;
	readonly parentSessionId: string;
	readonly subagentId: string;
	readonly pollMs?: number;
	readonly handleRequest: (request: {
		readonly operation: string;
		readonly payload: unknown;
	}) => Promise<unknown>;
	readonly diagnose?: (message: string) => void;
}): ChildMailbox {
	let db: ReturnType<typeof openStateDb> | undefined;
	let processLock: ProcessLock | undefined;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const lifetime = new AbortController();
	let closed = false;
	let started = false;
	let working = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const database = (): ReturnType<typeof openStateDb> => {
		if (db === undefined) throw new BridgeError("not_connected", "the state database is not open");
		return db;
	};

	const tick = async (): Promise<void> => {
		if (closed || working || db === undefined) return;
		working = true;
		const current = db;
		try {
			if (!hasPendingCommand(current, options.parentSessionId, "to_child", options.subagentId)) {
				return;
			}
			const command = withWrite(current, () =>
				claimCommand(current, options.parentSessionId, options.subagentId, "to_child"),
			);
			if (command === undefined) return;
			await answer(current, command, options.handleRequest, options.diagnose);
		} finally {
			working = false;
		}
	};

	return {
		get connected() {
			return started && !closed;
		},
		start() {
			if (started || closed) return;
			try {
				db = openStateDb(options.filePath);
				const lockPath = processLockPath(
					options.filePath,
					options.parentSessionId,
					options.subagentId,
				);
				if (lockPath === undefined) throw new Error("invalid process lock id");
				processLock = holdProcessLock(lockPath);
			} catch (error) {
				processLock?.release();
				processLock = undefined;
				db = undefined;
				options.diagnose?.(`could not hold the child process lock: ${errorMessage(error)}`);
				return;
			}
			started = true;
			timer = setInterval(() => {
				void tick().catch((error: unknown) => {
					options.diagnose?.(`could not take a parent command: ${errorMessage(error)}`);
				});
			}, pollMs);
			timer.unref?.();
			void tick().catch((error: unknown) => {
				options.diagnose?.(`could not take a parent command: ${errorMessage(error)}`);
			});
		},
		report(operation, payload, signal) {
			const current = database();
			const id = randomUUID();
			enqueueCommand(current, {
				id,
				parentSessionId: options.parentSessionId,
				subagentId: options.subagentId,
				direction: "to_parent",
				operation,
				payload: JSON.stringify(payload ?? null),
				createdAt: Date.now(),
			});
			return waitForCommand(current, id, {
				timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
				pollMs,
				signal: untilClosed(signal, lifetime.signal),
				...(options.diagnose === undefined ? {} : { diagnose: options.diagnose }),
			});
		},
		sendEvent(event) {
			if (db === undefined) return;
			const current = db;
			try {
				withWrite(current, () => {
					enqueueCommand(current, {
						id: randomUUID(),
						parentSessionId: options.parentSessionId,
						subagentId: options.subagentId,
						direction: "to_parent",
						operation: "event",
						payload: JSON.stringify(event ?? null),
						createdAt: Date.now(),
					});
					trimEventBacklog(
						current,
						options.parentSessionId,
						options.subagentId,
						DEFAULT_MAX_BUFFERED_EVENTS,
					);
				});
			} catch (error) {
				// An advisory frame is never worth failing a turn over.
				options.diagnose?.(`could not queue an event: ${errorMessage(error)}`);
			}
		},
		close() {
			closed = true;
			started = false;
			if (timer !== undefined) clearInterval(timer);
			lifetime.abort(new BridgeError("closed", "The child mailbox was closed"));
			processLock?.release();
			processLock = undefined;
		},
	};
}

async function answer(
	db: ReturnType<typeof openStateDb>,
	command: StoredCommand,
	handleRequest: (request: {
		readonly operation: string;
		readonly payload: unknown;
	}) => Promise<unknown>,
	diagnose?: (message: string) => void,
): Promise<void> {
	try {
		const payload = JSON.parse(command.payload) as unknown;
		const result = await handleRequest({ operation: command.operation, payload });
		finishCommand(db, command.id, { status: "done", result: JSON.stringify(result ?? null) });
	} catch (error) {
		const bridge = error instanceof BridgeError ? error : undefined;
		diagnose?.(`child command ${command.operation} failed: ${errorMessage(error)}`);
		finishCommand(db, command.id, {
			status: "failed",
			errorCode: bridge?.code ?? "request_failed",
			error: bridge?.message ?? errorMessage(error),
		});
	}
}

function waitForCommand(
	db: ReturnType<typeof openStateDb>,
	id: string,
	options: {
		readonly timeoutMs: number;
		readonly pollMs: number;
		readonly signal?: AbortSignal;
		readonly diagnose?: (message: string) => void;
	},
): Promise<unknown> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const drop = (): void => {
			try {
				withWrite(db, () => {
					deleteCommand(db, id);
				});
			} catch (error) {
				options.diagnose?.(`could not drop command ${id}: ${errorMessage(error)}`);
			}
		};
		const finish = (): void => {
			clearInterval(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			finish();
			drop();
			reject(abortReason(options.signal));
		};
		const timer = setInterval(() => {
			// The deadline is read before the row, so a row another writer deleted can never leave
			// this waiter polling forever.
			const expired = Date.now() - started >= options.timeoutMs;
			let command: StoredCommand | undefined;
			try {
				command = readCommand(db, id);
			} catch (error) {
				finish();
				reject(new BridgeError("state_unavailable", errorMessage(error)));
				return;
			}
			if (command === undefined) {
				if (!expired) return;
				finish();
				reject(new BridgeError("timeout", `No answer for ${id} after ${options.timeoutMs}ms`));
				return;
			}
			if (command.status === "done") {
				finish();
				drop();
				try {
					resolve(command.result === null ? null : (JSON.parse(command.result) as unknown));
				} catch (error) {
					reject(new BridgeError("malformed_result", errorMessage(error)));
				}
				return;
			}
			if (command.status === "failed") {
				finish();
				drop();
				reject(
					new BridgeError(
						command.errorCode ?? "request_failed",
						command.error ?? "The command failed",
					),
				);
				return;
			}
			if (expired) {
				finish();
				drop();
				reject(new BridgeError("timeout", `No answer for ${id} after ${options.timeoutMs}ms`));
			}
		}, options.pollMs);
		timer.unref?.();
		if (options.signal?.aborted === true) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** A caller's own cancellation and this transport's lifetime both settle a waiting request. */
function untilClosed(signal: AbortSignal | undefined, lifetime: AbortSignal): AbortSignal {
	return signal === undefined ? lifetime : AbortSignal.any([signal, lifetime]);
}

function abortReason(signal: AbortSignal | undefined): BridgeError {
	const reason: unknown = signal?.reason;
	if (reason instanceof BridgeError) return reason;
	return new BridgeError("aborted", "The mailbox request was cancelled");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
