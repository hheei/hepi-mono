import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { errorMessage } from "@hheei/pi-ext-core";
import { type ChildIdentity, PROTOCOL_VERSION } from "./domain.js";
import {
	attachJsonLineReader,
	JsonLineError,
	serializeJsonLine,
	writeJsonLine,
} from "./json-lines.js";
import {
	BridgeError,
	CHILD_INPUT_EVENT,
	type ChildInputSource,
	DEFAULT_MAX_BUFFERED_EVENTS,
	DEFAULT_MAX_FRAME_BYTES,
	failureResponse,
	isHelloAckFrame,
	isRequestFrame,
	isResponseFrame,
	successResponse,
} from "./protocol.js";

/** How long a child waits before dialing the parent again. */
const DEFAULT_RECONNECT_DELAY_MS = 500;

/** A socket the parent accepts but never answers on is not a working control channel. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long a delivered report waits for the parent's answer before it fails. Without this a parent
 * that keeps the socket open and never answers would hold the report queue forever.
 */
const DEFAULT_REPORT_TIMEOUT_MS = 30_000;

export interface ChildBridgeRequest {
	readonly operation: string;
	readonly payload: unknown;
}

export interface ChildBridgeClientOptions {
	/** The parent's bridge socket. */
	readonly endpoint: string;
	readonly identity: ChildIdentity;
	/** Executes a parent request; a thrown error becomes a failure response. */
	readonly handleRequest: (request: ChildBridgeRequest) => Promise<unknown>;
	/**
	 * Called after every successful handshake, including the first. A reconnecting child uses it to
	 * resend whatever state the parent needs to stay synchronized.
	 */
	readonly onConnect?: () => void;
	readonly reconnectDelayMs?: number;
	readonly maxBufferedReports?: number;
	readonly maxFrameBytes?: number;
	readonly connectTimeoutMs?: number;
	readonly reportTimeoutMs?: number;
	readonly diagnose?: (message: string) => void;
}

interface ReportDelivery {
	/**
	 * The request id, minted once per report. A retry after a lost connection therefore repeats the
	 * same request instead of looking like a second report, and the parent can answer it from the
	 * result it already produced. It carries this client's instance id, because the parent keys
	 * answered requests by request id: a relaunched process counts from one again and would
	 * otherwise be answered with the previous process's result.
	 */
	readonly id: string;
	readonly operation: string;
	readonly payload: unknown;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	/** Set when the connection dropped while this report was in flight. */
	requeued: boolean;
}

interface InFlightReport {
	readonly delivery: ReportDelivery;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

/**
 * The child side of the bridge: one long-lived connection to the parent, carrying both directions
 * of control.
 *
 * The child therefore never owns its own lifecycle endpoint: it dials the parent, keeps dialing
 * while the parent is away, and reconnects with the same identity when the parent comes back (a
 * parent restart re-listens the same socket path). Reports the parent has not accepted yet are
 * buffered here, bounded, and flushed in order after a reconnect, so a report is never silently
 * lost just because the parent was momentarily gone. Pi events are advisory snapshots and are
 * dropped instead of buffered.
 */
export class ChildBridgeClient {
	readonly #options: ChildBridgeClientOptions;
	readonly #queued: ReportDelivery[] = [];
	readonly #inFlight = new Map<string, InFlightReport>();
	readonly #disconnectWaiters = new Set<() => void>();
	#socket: Socket | undefined;
	/** The socket of a handshake in progress, so close() can end it too. */
	#handshakeSocket: Socket | undefined;
	/** Identifies this client instance, so request ids stay unique across child relaunches. */
	readonly #instanceId = randomUUID().slice(0, 8);
	#detachReader: (() => void) | undefined;
	#requestSeq = 0;
	#connected = false;
	#closed = false;
	#flushing = false;
	#loop: Promise<void> | undefined;

	public constructor(options: ChildBridgeClientOptions) {
		this.#options = options;
	}

	public get connected(): boolean {
		return this.#connected;
	}

	/**
	 * Starts the connect loop. It keeps retrying on its own: a panel child outlives the parent
	 * process that started it, so being unable to reach the parent is a state to wait out, not a
	 * failure to give up on. Call `close()` to stop it.
	 */
	public start(): void {
		if (this.#loop !== undefined || this.#closed) return;
		this.#loop = this.#run();
	}

	/** Sends an advisory frame: Pi events and child lifecycle signals. */
	public sendEvent(event: unknown): void {
		const socket = this.#socket;
		if (socket === undefined || !this.#connected) return;
		let encoded: Buffer;
		try {
			encoded = serializeJsonLine(
				{ version: PROTOCOL_VERSION, type: "event", event },
				this.#frameLimit(),
			);
		} catch (error) {
			// The frame can never be sent — too large, or not serializable — and that says nothing about
			// the connection. An advisory event is dropped so the control channel stays usable.
			if (process.env.DEBUG || process.env.PI_SUBAGENTS_DEBUG) {
				this.#diagnose(`dropped an advisory frame: ${errorMessage(error)}`);
			}
			return;
		}
		socket.write(encoded, (error?: Error | null) => {
			// A write failure is the connection's problem: the reconnect loop owns it from here.
			if (error) this.#teardown(socket);
		});
	}

	/**
	 * Tells the parent that input arrived, with its source and nothing else. The parent uses this
	 * to cancel an idle countdown, so the text of a human message stays inside the child.
	 */
	public sendChildInput(source: ChildInputSource): void {
		const { parentSessionId, subagentId, runtimeIdentity } = this.#options.identity;
		this.sendEvent({
			type: CHILD_INPUT_EVENT,
			parentSessionId,
			childId: subagentId,
			runtimeIdentity,
			source,
		});
	}

	/**
	 * Reports to the parent, waiting for its answer. While the parent is unreachable the report is
	 * buffered instead of failed, and delivered after the reconnect.
	 */
	public sendReport(operation: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
		if (this.#closed) {
			return Promise.reject(new BridgeError("bridge_closed", "The child bridge is closed"));
		}
		let delivery!: ReportDelivery;
		const delivered = new Promise<unknown>((resolve, reject) => {
			const limit = this.#options.maxBufferedReports ?? DEFAULT_MAX_BUFFERED_EVENTS;
			while (this.#queued.length >= limit) {
				// The report being delivered is still the head of the queue: evicting it would fail the
				// caller with "dropped" while the parent may already be acting on it.
				const index = this.#inFlight.size === 0 ? 0 : 1;
				const dropped = this.#queued.splice(index, 1)[0];
				if (dropped === undefined) break;
				this.#diagnose(`dropped a buffered ${dropped.operation} report: the buffer is full`);
				dropped.reject(
					new BridgeError(
						"report_buffer_full",
						`The ${dropped.operation} report was dropped: the parent is unreachable and the buffer is full`,
					),
				);
			}
			delivery = {
				id: `child-${this.#instanceId}-${++this.#requestSeq}`,
				operation,
				payload,
				resolve,
				reject,
				requeued: false,
			};
			this.#queued.push(delivery);
			void this.#flush();
		});
		if (signal === undefined) return delivered;
		// The caller is a tool call that can be cancelled. Without this the report would wait for the
		// parent to come back, and a cancelled call would hang until the process ends.
		if (signal.aborted) {
			this.#abandon(delivery);
			return Promise.reject(new BridgeError("aborted", `The ${operation} report was cancelled`));
		}
		return new Promise<unknown>((resolve, reject) => {
			const onAbort = (): void => {
				this.#abandon(delivery);
				reject(new BridgeError("aborted", `The ${operation} report was cancelled`));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			void delivered.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(error instanceof Error ? error : new Error(errorMessage(error)));
				},
			);
		});
	}

	/**
	 * Gives up on a report whose caller was cancelled: it leaves the queue instead of being delivered
	 * later, because the request it carried belongs to a tool call that no longer exists.
	 */
	#abandon(delivery: ReportDelivery): void {
		const index = this.#queued.indexOf(delivery);
		if (index >= 0) this.#queued.splice(index, 1);
		const inFlight = this.#inFlight.get(delivery.id);
		if (inFlight !== undefined) {
			clearTimeout(inFlight.timer);
			this.#inFlight.delete(delivery.id);
		}
		delivery.reject(new BridgeError("aborted", `The ${delivery.operation} report was cancelled`));
	}

	/** Stops reconnecting and fails everything still waiting for the parent. */
	public close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const socket = this.#socket ?? this.#handshakeSocket;
		this.#socket = undefined;
		this.#handshakeSocket = undefined;
		this.#connected = false;
		this.#detachReader?.();
		this.#detachReader = undefined;
		// `destroySoon` ends the socket after what is already written has gone out, so a lifecycle
		// notice reported just before the close is not dropped with the socket.
		socket?.destroySoon();
		const error = new BridgeError("bridge_closed", "The child bridge is closed");
		for (const inFlight of this.#inFlight.values()) {
			clearTimeout(inFlight.timer);
			inFlight.reject(error);
		}
		this.#inFlight.clear();
		for (const delivery of this.#queued.splice(0)) {
			delivery.reject(error);
		}
		this.#wakeDisconnectWaiters();
	}

	async #run(): Promise<void> {
		while (!this.#closed) {
			const opened = await this.#attemptOpen();
			if (this.#closed) return;
			if (opened) await this.#waitForDisconnect();
			if (this.#closed) return;
			await this.#delay();
		}
	}

	/** Dials the parent and completes the handshake; false means "try again later". */
	async #attemptOpen(): Promise<boolean> {
		const socket = createConnection(this.#options.endpoint);
		this.#handshakeSocket = socket;
		let handshaked = false;
		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const settle = (error?: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (error === undefined) resolve();
					else reject(error);
				};
				const timer = setTimeout(
					() => settle(new BridgeError("connect_timeout", "The parent did not answer the hello")),
					this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
				);
				socket.on("error", (error: Error) => settle(error));
				socket.on("close", () =>
					settle(new BridgeError("connection_lost", "The parent closed the bridge socket")),
				);
				socket.once("connect", () => {
					void writeJsonLine(
						socket,
						{
							version: PROTOCOL_VERSION,
							type: "hello",
							role: "child",
							...this.#options.identity,
							token: this.#options.identity.token,
						},
						this.#frameLimit(),
					).catch((error: unknown) => settle(new Error(errorMessage(error))));
				});
				this.#detachReader = attachJsonLineReader(socket, {
					maxFrameBytes: this.#frameLimit(),
					onError: (error) => {
						if (!handshaked) {
							settle(error);
							return;
						}
						// A frame the reader cannot parse means this socket can never deliver a response, so
						// it is dropped like any other lost connection instead of staying "connected" and mute.
						this.#teardown(socket);
					},
					onValue: (value) => {
						if (!handshaked) {
							if (!isHelloAckFrame(value)) {
								settle(
									new BridgeError(
										"invalid_handshake",
										"The parent sent an invalid handshake response",
									),
								);
								return;
							}
							handshaked = true;
							settle();
							return;
						}
						this.#receive(value);
					},
				});
			});
		} catch {
			this.#detachReader?.();
			this.#detachReader = undefined;
			if (this.#handshakeSocket === socket) this.#handshakeSocket = undefined;
			socket.destroy();
			return false;
		}
		if (this.#handshakeSocket === socket) this.#handshakeSocket = undefined;
		if (this.#closed || socket.destroyed) {
			socket.destroy();
			return false;
		}
		this.#socket = socket;
		this.#connected = true;
		socket.on("close", () => this.#teardown(socket));
		socket.on("error", () => this.#teardown(socket));
		try {
			this.#options.onConnect?.();
		} catch (error) {
			this.#diagnose(`onConnect handler failed: ${errorMessage(error)}`);
		}
		void this.#flush();
		return true;
	}

	#receive(value: unknown): void {
		if (isResponseFrame(value)) {
			const inFlight = this.#inFlight.get(value.id);
			if (inFlight === undefined) return;
			this.#inFlight.delete(value.id);
			clearTimeout(inFlight.timer);
			if (value.ok) inFlight.resolve(value.data);
			else inFlight.reject(new BridgeError(value.error.code, value.error.message));
			return;
		}
		if (isRequestFrame(value)) {
			void this.#serve(value.id, value.operation, value.payload);
			return;
		}
		this.#diagnose("ignored a frame the child bridge does not understand");
	}

	async #serve(id: string, operation: string, payload: unknown): Promise<void> {
		try {
			const data = await this.#options.handleRequest({ operation, payload });
			this.#send(successResponse(id, data), id);
		} catch (error) {
			const code = error instanceof BridgeError ? error.code : "bridge_error";
			this.#send(failureResponse(id, code, errorMessage(error)));
		}
	}

	/** Delivers queued reports in order, one at a time, so the parent sees them as they happened. */
	async #flush(): Promise<void> {
		if (this.#flushing) return;
		this.#flushing = true;
		try {
			while (!this.#closed) {
				const delivery = this.#queued[0];
				const socket = this.#socket;
				if (delivery === undefined || socket === undefined || !this.#connected) return;
				let value: unknown;
				try {
					value = await this.#deliver(socket, delivery);
				} catch (error) {
					// A dropped connection leaves the report at the head of the queue, marked for retry;
					// only a report the parent actually answered (or a closed bridge) stops being retried.
					if (delivery.requeued) return;
					if (this.#queued[0] === delivery) this.#queued.shift();
					delivery.reject(error instanceof Error ? error : new Error(errorMessage(error)));
					continue;
				}
				if (this.#queued[0] === delivery) this.#queued.shift();
				delivery.resolve(value);
			}
		} finally {
			this.#flushing = false;
		}
	}

	async #deliver(socket: Socket, delivery: ReportDelivery): Promise<unknown> {
		delivery.requeued = false;
		let encoded: Buffer;
		try {
			encoded = serializeJsonLine(
				{
					version: PROTOCOL_VERSION,
					type: "request",
					id: delivery.id,
					operation: delivery.operation,
					...(delivery.payload === undefined ? {} : { payload: delivery.payload }),
				},
				this.#frameLimit(),
			);
		} catch (error) {
			// The frame itself cannot be sent — too large, or not serializable — so retrying it on every
			// reconnect would never succeed. Only writing it is a connection problem.
			throw error instanceof JsonLineError
				? new BridgeError(error.code, error.message)
				: new BridgeError("unserializable_frame", errorMessage(error));
		}
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				const inFlight = this.#inFlight.get(delivery.id);
				if (inFlight === undefined) return;
				this.#inFlight.delete(delivery.id);
				reject(
					new BridgeError(
						"timeout",
						`The parent did not answer the ${delivery.operation} report in time`,
					),
				);
			}, this.#options.reportTimeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS);
			this.#inFlight.set(delivery.id, { delivery, resolve, reject, timer });
			socket.write(encoded, (error?: Error | null) => {
				if (!error) return;
				// A transport failure is the connection's problem: the teardown path requeues this report
				// and reconnects, so a report is not lost to a momentary write error.
				this.#teardown(socket);
			});
		});
	}

	#send(frame: unknown, responseId?: string): void {
		const socket = this.#socket;
		if (socket === undefined || !this.#connected) return;
		void writeJsonLine(socket, frame, this.#frameLimit()).catch((error: unknown) => {
			if (responseId === undefined) {
				this.#teardown(socket);
				return;
			}
			// A response the parent cannot receive must not take the control channel down with it: it
			// gets a visible failure instead, and the connection stays usable.
			this.#diagnose(`could not answer request ${responseId}: ${errorMessage(error)}`);
			void writeJsonLine(
				socket,
				failureResponse(responseId, "response_too_large", errorMessage(error)),
				this.#frameLimit(),
			).catch(() => {
				this.#teardown(socket);
			});
		});
	}

	#teardown(socket: Socket): void {
		if (this.#closed) return;
		if (this.#socket !== undefined && this.#socket !== socket) {
			socket.destroy();
			return;
		}
		this.#socket = undefined;
		this.#connected = false;
		this.#detachReader?.();
		this.#detachReader = undefined;
		if (!socket.destroyed) socket.destroy();
		for (const [id, inFlight] of this.#inFlight) {
			this.#inFlight.delete(id);
			clearTimeout(inFlight.timer);
			// The parent never answered, so this report still owes it a delivery. It is already the head
			// of the queue (a report leaves that position only once it is answered), so it is marked for
			// the retry and not pushed again: a duplicate would report contact_parent twice.
			inFlight.delivery.requeued = true;
			inFlight.reject(new BridgeError("connection_lost", "The parent bridge connection was lost"));
		}
		this.#wakeDisconnectWaiters();
	}

	/** Wakes every reconnect wait; the next loop registers its own. */
	#wakeDisconnectWaiters(): void {
		const waiters = [...this.#disconnectWaiters];
		this.#disconnectWaiters.clear();
		for (const waiter of waiters) {
			waiter();
		}
	}

	#waitForDisconnect(): Promise<void> {
		// The socket may already have dropped between the handshake and this call.
		if (!this.#connected) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.#disconnectWaiters.add(resolve);
		});
	}

	#delay(): Promise<void> {
		const delayMs = this.#options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
		return new Promise<void>((resolve) => {
			setTimeout(resolve, delayMs);
		});
	}

	#frameLimit(): number {
		return this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
	}

	#diagnose(message: string): void {
		if (this.#options.diagnose !== undefined) this.#options.diagnose(message);
		else if (process.env.DEBUG || process.env.PI_SUBAGENTS_DEBUG) {
			console.error(`pi-subagents child bridge: ${message}`);
		}
	}
}
