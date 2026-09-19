import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { errorMessage, toError, writeDiagnostic } from "./diagnostics.js";
import { type ChildIdentity, isRecord, PROTOCOL_VERSION } from "./domain.js";
import { attachJsonLineReader, writeJsonLine } from "./json-lines.js";
import {
	type ContactReportPayload,
	DEFAULT_MAX_BUFFERED_EVENTS,
	DEFAULT_MAX_FRAME_BYTES,
	DEFAULT_MAX_PENDING_REQUESTS,
	eventFrame,
	failureResponse,
	isContactReportPayload,
	isHelloFrame,
	isRequestFrame,
	type ResponseFrame,
	RUNNER_EVENTS_DROPPED_EVENT,
	RUNNER_EXIT_EVENT,
	successResponse,
} from "./protocol.js";
import { PiRpcAdapter, type PiRpcOperation, PiRpcTimeoutError } from "./rpc-adapter.js";

/** Bounded memory of finished request IDs, used to answer duplicate requests. */
const MAX_RETIRED_REQUEST_IDS = 256;
/** Unauthenticated connections accepted at once before new ones are refused. */
const MAX_PENDING_HANDSHAKES = 16;

interface PendingHandshake {
	readonly detach: () => void;
	readonly timer: NodeJS.Timeout;
}

interface ControllerLink {
	readonly socket: Socket;
	readonly detach: () => void;
	readonly requests: Map<string, AbortController>;
	/** Finished IDs for this controller only; a new controller starts clean. */
	readonly retired: Set<string>;
}

interface ReporterLink {
	readonly socket: Socket;
	readonly detach: () => void;
}

export interface SubagentRunnerOptions {
	readonly identity: ChildIdentity;
	/** The Pi `--mode rpc` child owned by this runner. */
	readonly process: ChildProcessWithoutNullStreams;
	readonly maxFrameBytes?: number;
	readonly maxPendingRequests?: number;
	readonly maxBufferedEvents?: number;
	/** Queued bytes tolerated on a controller socket before it is dropped. */
	readonly maxControllerBufferBytes?: number;
	readonly requestTimeoutMs?: number;
	readonly readyTimeoutMs?: number;
	readonly handshakeTimeoutMs?: number;
	readonly shutdownGraceMs?: number;
	readonly killGraceMs?: number;
	readonly onDiagnostic?: (line: string) => void;
	/** Atomically consumes a durable recovery claim for a one-time controller token. */
	readonly authorizeRecovery?: (claimId: string, token: string) => Promise<boolean>;
}

/** Observed end of the Pi child owned by the runner. */
export interface RunnerExit {
	readonly code: number | null;
	readonly signal: string | null;
	readonly reason: Error;
	/** True when an explicit shutdown ended the runtime, not the child itself. */
	readonly requested: boolean;
}

export interface SubagentRunner {
	readonly endpoint: string;
	readonly identity: ChildIdentity;
	/** Real `get_state` data captured when the Pi child became ready. */
	readonly readiness: unknown;
	/** Resolves once the Pi child exited and every runner resource is released. */
	closed(): Promise<RunnerExit>;
	shutdown(reason?: Error): Promise<RunnerExit>;
}

/**
 * Starts the reconnectable runner endpoint for one Pi RPC child.
 *
 * The runner owns the child stdio, accepts exactly one authenticated controller
 * at a time, and stays alive across controller disconnects: only an explicit
 * `shutdown` request, the end of the Pi child, or process termination stops it.
 */
export async function startRunner(options: SubagentRunnerOptions): Promise<SubagentRunner> {
	const runner = new Runner(options);
	const readiness = await runner.start();
	return {
		endpoint: runner.endpoint,
		identity: options.identity,
		readiness,
		closed: () => runner.closed(),
		shutdown: (reason?: Error) => runner.shutdown(reason),
	};
}

class Runner {
	readonly endpoint: string;
	readonly identity: ChildIdentity;
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #adapter: PiRpcAdapter;
	readonly #diagnose: (line: string) => void;
	readonly #maxFrameBytes: number;
	readonly #maxPendingRequests: number;
	readonly #maxBufferedEvents: number;
	readonly #maxControllerBufferBytes: number;
	readonly #requestTimeoutMs: number;
	readonly #readyTimeoutMs: number;
	readonly #handshakeTimeoutMs: number;
	readonly #shutdownGraceMs: number;
	readonly #killGraceMs: number;
	readonly #pendingHandshakes = new Map<Socket, PendingHandshake>();
	readonly #authenticating = new Set<Socket>();
	readonly #bufferedEvents: unknown[] = [];
	readonly #detachEvents: () => void;
	readonly #reporters = new Map<Socket, ReporterLink>();
	readonly #pendingReports: ContactReportPayload[] = [];
	#controller: ControllerLink | undefined;
	#server: Server | undefined;
	#boundEndpoint = false;
	#droppedEvents = 0;
	#readyState: unknown = undefined;
	#shutdownRequested = false;
	#exit: RunnerExit | undefined;
	#closing: Promise<RunnerExit> | undefined;
	readonly #authorizeRecovery: ((claimId: string, token: string) => Promise<boolean>) | undefined;
	#resolveClosed: ((exit: RunnerExit) => void) | undefined;

	public constructor(options: SubagentRunnerOptions) {
		this.endpoint = options.identity.endpoint;
		this.identity = options.identity;
		this.#process = options.process;
		this.#diagnose = options.onDiagnostic ?? ((line: string) => writeDiagnostic("runner", line));
		this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
		this.#maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
		this.#maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
		this.#maxControllerBufferBytes = options.maxControllerBufferBytes ?? 4 * this.#maxFrameBytes;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
		this.#readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
		this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
		this.#shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
		this.#killGraceMs = options.killGraceMs ?? 1_000;
		this.#authorizeRecovery = options.authorizeRecovery;
		this.#adapter = new PiRpcAdapter({
			process: options.process,
			maxFrameBytes: this.#maxFrameBytes,
			maxPendingRequests: this.#maxPendingRequests,
			requestTimeoutMs: this.#requestTimeoutMs,
			onListenerError: (error) => this.#diagnose(`event listener failed: ${errorMessage(error)}`),
		});
		this.#detachEvents = this.#adapter.onEvent((event) => this.#broadcast(event));
	}

	/** Confirms a real Pi RPC round trip, then publishes the endpoint. */
	public async start(): Promise<unknown> {
		this.#process.once("exit", (code, signal) => this.#onChildExit(code, signal));
		try {
			this.#readyState = await this.#adapter.ready(AbortSignal.timeout(this.#readyTimeoutMs));
		} catch (error) {
			this.#detachEvents();
			this.#adapter.close(toError(error));
			throw new Error(`Pi RPC did not become ready: ${errorMessage(error)}`);
		}
		try {
			await this.#listen();
		} catch (error) {
			await this.shutdown(toError(error));
			throw toError(error);
		}
		return this.#readyState;
	}

	public closed(): Promise<RunnerExit> {
		if (this.#exit !== undefined) return Promise.resolve(this.#exit);
		return new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	public shutdown(reason = new Error("Runner shutdown requested")): Promise<RunnerExit> {
		if (this.#closing !== undefined) return this.#closing;
		this.#closing = this.#runShutdown(reason);
		return this.#closing;
	}

	async #runShutdown(reason: Error): Promise<RunnerExit> {
		this.#shutdownRequested = true;
		this.#diagnose(`shutting down: ${reason.message}`);
		try {
			return await this.#cleanup(reason);
		} catch (error) {
			this.#diagnose(`shutdown cleanup failed: ${errorMessage(error)}`);
			const exit: RunnerExit = this.#exit ?? {
				code: this.#process.exitCode,
				signal: this.#process.signalCode,
				reason,
				requested: true,
			};
			this.#finish(exit);
			return exit;
		}
	}

	async #cleanup(reason: Error): Promise<RunnerExit> {
		const controller = this.#controller;
		this.#controller = undefined;
		if (controller !== undefined) {
			// Let the final events (child exit, gap notice) reach a live controller.
			await drainSocket(controller.socket, 250);
			this.#destroyController(controller, reason);
		}
		for (const [socket, handshake] of this.#pendingHandshakes) {
			clearTimeout(handshake.timer);
			handshake.detach();
			socket.destroy();
		}
		this.#pendingHandshakes.clear();
		for (const reporter of this.#reporters.values()) this.#dropReporter(reporter);
		this.#reporters.clear();
		await this.#closeServer();
		await this.#releaseChild();
		this.#detachEvents();
		this.#adapter.close(reason);
		const exit: RunnerExit = this.#exit ?? {
			code: this.#process.exitCode,
			signal: this.#process.signalCode,
			reason,
			requested: true,
		};
		this.#finish(exit);
		return exit;
	}

	async #listen(): Promise<void> {
		await this.#clearStaleEndpoint();
		const server = createServer({ allowHalfOpen: false });
		this.#server = server;
		server.on("connection", (socket) => this.#accept(socket));
		server.on("error", (error) => this.#diagnose(`socket server error: ${errorMessage(error)}`));
		const listening = new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.endpoint, () => {
				server.off("error", reject);
				resolve();
			});
		});
		try {
			await listening;
		} catch (error) {
			this.#server = undefined;
			server.close();
			throw toError(error);
		}
		this.#boundEndpoint = true;
		await this.#restrictEndpoint();
	}

	/**
	 * Refuses to steal an endpoint owned by a live runner. A socket that exists
	 * but cannot be connected to is a leftover from a dead runner and is removed.
	 */
	async #clearStaleEndpoint(): Promise<void> {
		try {
			const stats = await lstat(this.endpoint);
			if (!stats.isSocket()) {
				throw new Error(`runner endpoint path exists and is not a Unix socket: ${this.endpoint}`);
			}
		} catch (error) {
			if (isErrno(error, "ENOENT")) return;
			throw toError(error);
		}
		if (await isEndpointLive(this.endpoint)) {
			throw new Error(`a live runner already owns endpoint ${this.endpoint}`);
		}
		await unlink(this.endpoint);
		this.#diagnose(`removed stale endpoint ${this.endpoint}`);
	}

	async #restrictEndpoint(): Promise<void> {
		try {
			await chmod(this.endpoint, 0o600);
		} catch (error) {
			this.#diagnose(`could not restrict endpoint permissions: ${errorMessage(error)}`);
		}
	}

	async #closeServer(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (server !== undefined) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
		// Only remove a socket this runner created; another live runner may own it.
		if (!this.#boundEndpoint) return;
		this.#boundEndpoint = false;
		try {
			await unlink(this.endpoint);
		} catch (error) {
			if (!isErrno(error, "ENOENT"))
				this.#diagnose(`could not remove endpoint: ${errorMessage(error)}`);
		}
	}

	#accept(socket: Socket): void {
		if (this.#pendingHandshakes.size >= MAX_PENDING_HANDSHAKES) {
			this.#diagnose("refused connection: too many unauthenticated connections");
			socket.destroy();
			return;
		}
		socket.setNoDelay(true);
		const detach = attachJsonLineReader(socket, {
			maxFrameBytes: this.#maxFrameBytes,
			onError: (error) => {
				this.#diagnose(`controller stream error: ${error.message}`);
				this.#dropSocket(socket);
			},
			onValue: (value) => {
				const reporter = this.#reporters.get(socket);
				if (reporter !== undefined) {
					this.#handleReporterRequest(reporter, value);
					return;
				}
				const controller = this.#controller;
				if (controller !== undefined && controller.socket === socket) {
					this.#handleRequest(controller, value);
					return;
				}
				if (this.#authenticating.has(socket)) {
					this.#diagnose("rejected connection: overlapping handshake frames");
					this.#dropSocket(socket);
					return;
				}
				void this.#authenticate(socket, value);
			},
		});
		const timer = setTimeout(() => {
			this.#diagnose("refused connection: handshake deadline exceeded");
			this.#dropSocket(socket);
		}, this.#handshakeTimeoutMs);
		this.#pendingHandshakes.set(socket, { detach, timer });
		socket.once("close", () => {
			const handshake = this.#pendingHandshakes.get(socket);
			if (handshake !== undefined) {
				clearTimeout(handshake.timer);
				this.#pendingHandshakes.delete(socket);
				handshake.detach();
				return;
			}
			const reporter = this.#reporters.get(socket);
			if (reporter !== undefined) {
				this.#reporters.delete(socket);
				reporter.detach();
				return;
			}
			const controller = this.#controller;
			if (controller === undefined || controller.socket !== socket) return;
			this.#controller = undefined;
			controller.detach();
			this.#diagnose("controller disconnected; runner keeps running");
		});
	}

	/** Only a connection that proves identity and token may control the runner. */
	async #authenticate(socket: Socket, value: unknown): Promise<void> {
		const handshake = this.#pendingHandshakes.get(socket);
		if (handshake === undefined) {
			socket.destroy();
			return;
		}
		if (!isHelloFrame(value) || !this.#matchesStaticIdentity(value)) {
			this.#diagnose("rejected connection: handshake did not authenticate");
			this.#dropSocket(socket);
			return;
		}
		this.#authenticating.add(socket);
		try {
			const authenticated =
				value.role === "recovery"
					? value.claimId !== undefined &&
						this.#authorizeRecovery !== undefined &&
						(await this.#authorizeRecovery(value.claimId, value.token))
					: tokensMatch(value.token, this.identity.token);
			if (!authenticated || socket.destroyed || !this.#pendingHandshakes.has(socket)) {
				this.#diagnose("rejected connection: handshake did not authenticate");
				this.#dropSocket(socket);
				return;
			}
			clearTimeout(handshake.timer);
			this.#pendingHandshakes.delete(socket);
			if (value.role === "reporter") {
				const reporter: ReporterLink = { socket, detach: handshake.detach };
				this.#reporters.set(socket, reporter);
				void writeJsonLine(
					socket,
					{ version: PROTOCOL_VERSION, type: "hello_ack" },
					this.#maxFrameBytes,
				).catch((error: unknown) => {
					this.#diagnose(`reporter handshake write failed: ${errorMessage(error)}`);
					this.#dropReporter(reporter);
				});
				return;
			}
			const previous = this.#controller;
			if (previous !== undefined) {
				this.#diagnose("revoking previous controller");
				this.#controller = undefined;
				this.#destroyController(
					previous,
					new Error("Controller replaced by a new authenticated connection"),
				);
			}
			const link: ControllerLink = {
				socket,
				detach: handshake.detach,
				requests: new Map(),
				retired: new Set(),
			};
			this.#controller = link;
			void writeJsonLine(
				socket,
				{ version: PROTOCOL_VERSION, type: "hello_ack" },
				this.#maxFrameBytes,
			)
				.then(() => {
					this.#flushPendingReports(link);
					this.#flushBufferedEvents(link);
				})
				.catch((error: unknown) => {
					this.#diagnose(`controller handshake write failed: ${errorMessage(error)}`);
					this.#dropController(link, toError(error));
				});
		} catch (error) {
			this.#diagnose(`recovery authorization failed: ${errorMessage(error)}`);
			this.#dropSocket(socket);
		} finally {
			this.#authenticating.delete(socket);
		}
	}

	#matchesStaticIdentity(frame: {
		readonly parentSessionId: string;
		readonly subagentId: string;
		readonly runtimeIdentity: string;
		readonly endpoint: string;
		readonly token: string;
	}): boolean {
		const identity = this.identity;
		return (
			frame.parentSessionId === identity.parentSessionId &&
			frame.subagentId === identity.subagentId &&
			frame.runtimeIdentity === identity.runtimeIdentity &&
			frame.endpoint === identity.endpoint
		);
	}

	#handleReporterRequest(link: ReporterLink, value: unknown): void {
		if (
			!isRequestFrame(value) ||
			value.operation !== "contact_parent" ||
			!isContactReportPayload(value.payload) ||
			value.payload.parentSessionId !== this.identity.parentSessionId ||
			value.payload.childId !== this.identity.subagentId ||
			value.payload.runtimeIdentity !== this.identity.runtimeIdentity
		) {
			void this.#respondReporter(
				link,
				failureResponse("report", "invalid_report", "Reporter sent an invalid report"),
			);
			return;
		}
		const accepted = this.#deliverOrQueueReport(value.payload);
		void this.#respondReporter(
			link,
			accepted
				? successResponse(value.id)
				: failureResponse(value.id, "report_queue_full", "Parent report queue is full"),
		);
	}

	async #respondReporter(link: ReporterLink, frame: ResponseFrame): Promise<void> {
		try {
			await writeJsonLine(link.socket, frame, this.#maxFrameBytes);
		} finally {
			this.#dropReporter(link);
		}
	}

	#dropReporter(link: ReporterLink): void {
		if (this.#reporters.get(link.socket) === link) this.#reporters.delete(link.socket);
		link.detach();
		if (!link.socket.destroyed) link.socket.destroy();
	}

	#deliverOrQueueReport(report: ContactReportPayload): boolean {
		if (this.#pendingReports.length >= this.#maxBufferedEvents) return false;
		const link = this.#controller;
		if (link !== undefined && link.socket.writableLength <= this.#maxControllerBufferBytes) {
			void writeJsonLine(
				link.socket,
				eventFrame({ type: "subagent_report", report }),
				this.#maxFrameBytes,
			).catch((error: unknown) => {
				this.#diagnose(`parent report delivery failed: ${errorMessage(error)}`);
				this.#dropController(link, toError(error));
				if (this.#pendingReports.length < this.#maxBufferedEvents)
					this.#pendingReports.push(report);
			});
			return true;
		}
		if (this.#pendingReports.length >= this.#maxBufferedEvents) return false;
		this.#pendingReports.push(report);
		return true;
	}

	#flushPendingReports(link: ControllerLink): void {
		if (this.#controller !== link) return;
		const reports = this.#pendingReports.splice(0, this.#pendingReports.length);
		for (const report of reports) {
			void writeJsonLine(
				link.socket,
				eventFrame({ type: "subagent_report", report }),
				this.#maxFrameBytes,
			).catch((error: unknown) => {
				this.#pendingReports.unshift(report);
				this.#diagnose(`parent report catch-up failed: ${errorMessage(error)}`);
				this.#dropController(link, toError(error));
			});
		}
	}
	#handleRequest(link: ControllerLink, value: unknown): void {
		if (!isRequestFrame(value)) {
			this.#diagnose("controller sent a malformed frame");
			this.#dropController(link, new Error("Controller sent a malformed frame"));
			return;
		}
		const { id, operation } = value;
		if (link.retired.has(id) || link.requests.has(id)) {
			rememberRequestId(link.retired, id);
			void this.#respond(
				link,
				failureResponse(id, "duplicate_request_id", `Request ${id} is already known`),
			);
			return;
		}
		if (link.requests.size >= this.#maxPendingRequests) {
			void this.#respond(
				link,
				failureResponse(id, "too_many_pending_requests", "Runner pending request limit exceeded"),
			);
			return;
		}
		if (operation === "shutdown") {
			rememberRequestId(link.retired, id);
			void this.#respond(link, successResponse(id)).then(() =>
				this.shutdown(new Error("Controller requested shutdown")),
			);
			return;
		}
		if (operation === "contact_parent") {
			rememberRequestId(link.retired, id);
			void this.#respond(
				link,
				failureResponse(id, "reporter_required", "contact_parent requires a reporter connection"),
			);
			return;
		}
		const abort = new AbortController();
		link.requests.set(id, abort);
		void this.#forward(link, id, operation, value.payload, abort);
	}

	async #forward(
		link: ControllerLink,
		id: string,
		operation: PiRpcOperation,
		payload: unknown,
		abort: AbortController,
	): Promise<void> {
		try {
			const data = await this.#adapter.request(operation, payload, {
				signal: abort.signal,
				timeoutMs: this.#requestTimeoutMs,
			});
			await this.#respond(link, successResponse(id, data));
		} catch (error) {
			await this.#respond(link, failureResponse(id, errorCode(error), errorMessage(error)));
		} finally {
			link.requests.delete(id);
			rememberRequestId(link.retired, id);
		}
	}

	/** Answers only the controller that asked; a revoked controller gets nothing. */
	#respond(link: ControllerLink, frame: ResponseFrame): Promise<void> {
		if (this.#controller !== link || link.socket.destroyed) return Promise.resolve();
		return writeJsonLine(link.socket, frame, this.#maxFrameBytes).catch((error: unknown) => {
			this.#diagnose(`controller response write failed: ${errorMessage(error)}`);
			this.#dropController(link, toError(error));
		});
	}

	#broadcast(event: unknown): void {
		if (this.#exit !== undefined) return;
		const link = this.#controller;
		if (link !== undefined) {
			if (link.socket.writableLength > this.#maxControllerBufferBytes) {
				this.#diagnose(
					`controller is not reading events (${link.socket.writableLength} bytes queued)`,
				);
				this.#dropController(link, new Error("Controller is not reading runner events"));
			} else {
				void writeJsonLine(link.socket, eventFrame(event), this.#maxFrameBytes).catch(
					(error: unknown) => {
						this.#diagnose(`controller event write failed: ${errorMessage(error)}`);
						this.#dropController(link, toError(error));
						this.#bufferEvent(event);
					},
				);
				return;
			}
		}
		this.#bufferEvent(event);
	}

	#bufferEvent(event: unknown): void {
		if (this.#bufferedEvents.length >= this.#maxBufferedEvents) {
			this.#bufferedEvents.shift();
			this.#droppedEvents += 1;
		}
		this.#bufferedEvents.push(event);
	}

	/** Hands a reconnected controller the events it missed, or a gap notice. */
	#flushBufferedEvents(link: ControllerLink): void {
		if (this.#controller !== link) return;
		const pending = [...this.#bufferedEvents];
		this.#bufferedEvents.length = 0;
		const dropped = this.#droppedEvents;
		this.#droppedEvents = 0;
		if (dropped > 0) {
			pending.unshift({ type: RUNNER_EVENTS_DROPPED_EVENT, count: dropped });
		}
		for (const event of pending) {
			void writeJsonLine(link.socket, eventFrame(event), this.#maxFrameBytes).catch(
				(error: unknown) => {
					this.#bufferEvent(event);
					this.#diagnose(`controller catch-up write failed: ${errorMessage(error)}`);
					this.#dropController(link, toError(error));
				},
			);
		}
	}

	#onChildExit(code: number | null, signal: string | null): void {
		this.#diagnose(`Pi child exited (code=${String(code)}, signal=${String(signal)})`);
		this.#broadcast({ type: RUNNER_EXIT_EVENT, code, signal });
		this.#exit = {
			code,
			signal,
			reason: new Error(`Pi child exited (code=${String(code)}, signal=${String(signal)})`),
			// A child that dies while we are ending it was ended on purpose.
			requested: this.#shutdownRequested,
		};
		void this.shutdown(this.#exit.reason);
	}

	#dropSocket(socket: Socket): void {
		const handshake = this.#pendingHandshakes.get(socket);
		if (handshake !== undefined) {
			clearTimeout(handshake.timer);
			this.#pendingHandshakes.delete(socket);
			handshake.detach();
		}
		socket.destroy();
	}

	#dropController(link: ControllerLink, error: Error): void {
		if (this.#controller === link) this.#controller = undefined;
		this.#destroyController(link, error);
	}

	/** Fails every in-flight request of a controller that lost its authority. */
	#destroyController(link: ControllerLink, error: Error): void {
		link.detach();
		const requests = [...link.requests.values()];
		link.requests.clear();
		for (const request of requests) request.abort();
		if (!link.socket.destroyed) link.socket.destroy();
		this.#diagnose(`controller released: ${error.message}`);
	}

	/** Aborts the current turn, then ends the Pi child within fixed deadlines. */
	async #releaseChild(): Promise<void> {
		const child = this.#process;
		if (this.#exit === undefined && child.exitCode === null && child.signalCode === null) {
			try {
				await this.#adapter.request("abort", undefined, { timeoutMs: 1_000 });
			} catch (error) {
				this.#diagnose(`abort before shutdown failed: ${errorMessage(error)}`);
			}
		}
		if (await this.#waitForExit(0)) return;
		child.kill("SIGTERM");
		if (await this.#waitForExit(this.#shutdownGraceMs)) return;
		this.#diagnose("Pi child ignored SIGTERM; sending SIGKILL");
		child.kill("SIGKILL");
		if (await this.#waitForExit(this.#killGraceMs)) return;
		this.#diagnose("Pi child did not exit after SIGKILL");
	}

	#waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.#exit !== undefined) return Promise.resolve(true);
		if (this.#process.exitCode !== null || this.#process.signalCode !== null) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#process.off("exit", onExit);
				resolve(false);
			}, timeoutMs);
			const onExit = (): void => {
				clearTimeout(timer);
				resolve(true);
			};
			this.#process.once("exit", onExit);
		});
	}

	#finish(exit: RunnerExit): void {
		if (this.#exit === undefined) this.#exit = exit;
		const resolve = this.#resolveClosed;
		this.#resolveClosed = undefined;
		resolve?.(exit);
	}
}

/** Bounded FIFO memory of finished request IDs for one controller. */
function rememberRequestId(retired: Set<string>, id: string): void {
	retired.add(id);
	if (retired.size <= MAX_RETIRED_REQUEST_IDS) return;
	const oldest = retired.values().next();
	if (!oldest.done) retired.delete(oldest.value);
}

function errorCode(error: unknown): string {
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	if (error instanceof PiRpcTimeoutError) return "timeout";
	return "runner_error";
}

function tokensMatch(candidate: string, expected: string): boolean {
	const left = Buffer.from(candidate, "utf8");
	const right = Buffer.from(expected, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

/** Waits, within a fixed deadline, for queued socket writes to flush. */
function drainSocket(socket: Socket, timeoutMs: number): Promise<void> {
	if (socket.destroyed || socket.writableLength === 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			socket.off("drain", onDrain);
			resolve();
		}, timeoutMs);
		const onDrain = (): void => {
			clearTimeout(timer);
			resolve();
		};
		socket.once("drain", onDrain);
	});
}

/** True when a runner answers on this endpoint; connect failures mean stale. */
function isEndpointLive(endpoint: string): Promise<boolean> {
	const socket = createConnection(endpoint);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (live: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(live);
		};
		const timer = setTimeout(() => finish(true), 1_000);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
