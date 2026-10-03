import { chmod, lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { errorMessage, isRecord } from "@hheei/pi-ext-core";
import { PROTOCOL_VERSION } from "./domain.js";
import { attachJsonLineReader, serializeJsonLine } from "./json-lines.js";
import {
	BRIDGE_OPERATIONS,
	BridgeError,
	DEFAULT_MAX_FRAME_BYTES,
	DEFAULT_MAX_PENDING_REQUESTS,
	failureResponse,
	type HelloFrame,
	isEventFrame,
	isHelloFrame,
	isRequestFrame,
	isResponseFrame,
	successResponse,
} from "./protocol.js";

/**
 * A handshake must arrive promptly: a socket that connects and then stays silent is either a
 * probe or a broken client, and neither may occupy the server.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** How long the parent waits for a child's answer before failing the call visibly. */
export const DEFAULT_CHILD_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Reports are at-least-once: a child that loses the connection before the answer arrives sends the
 * same request again, and the parent answers it from the first result instead of acting twice. The
 * cache is per child and in memory — it covers a reconnect, not a parent restart.
 */
const MAX_SERVED_REQUESTS = 256;

/** How long adoption waits for a surviving child to reconnect. */
const DEFAULT_ADOPT_WAIT_MS = 5_000;

interface ConnectionWaiter {
	readonly childId: string;
	notify(connected: boolean): void;
}

export interface ChildRequest {
	readonly childId: string;
	readonly runtimeIdentity: string;
	readonly operation: string;
	readonly payload: unknown;
}

export interface ChildBridgeServerOptions {
	/** Socket path this parent session owns; children connect here. */
	readonly endpoint: string;
	/** The parent session served here; a hello naming another session is refused. */
	readonly parentSessionId: string;
	/**
	 * Verifies the child's hello — its runtime token, and whatever else the parent needs to believe
	 * it (for example that this runtime is the one the registry records for this child). Returns a
	 * message to refuse the connection, or undefined to accept it.
	 */
	readonly authorize: (frame: HelloFrame) => string | undefined | Promise<string | undefined>;
	/**
	 * Child-initiated requests the parent answers: reports and task results.
	 */
	readonly handleRequest: (request: ChildRequest) => Promise<unknown>;
	readonly requestTimeoutMs?: number;
	readonly maxFrameBytes?: number;
	readonly maxPendingRequests?: number;
	readonly diagnose?: (message: string) => void;
}

export interface ChildRequestOptions {
	readonly timeoutMs?: number;
}

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

interface ChildConnection {
	readonly childId: string;
	readonly runtimeIdentity: string;
	readonly socket: Socket;
	readonly pending: Map<string, PendingRequest>;
	closed: boolean;
}

/**
 * The parent side of the child bridge: one Unix socket per parent session, one long-lived
 * connection per child, carrying both directions of control.
 *
 * Control lives in the parent process instead of a helper process, so a child presented in a host
 * panel and a child running headless are driven by exactly the same requests. A child that
 * reconnects (parent restart, extension reload, dropped socket) replaces its previous connection
 * and is otherwise treated as the same runtime.
 */
export class ChildBridgeServer {
	readonly #options: ChildBridgeServerOptions;
	readonly #connections = new Map<string, ChildConnection>();
	/**
	 * Requests already answered, keyed by runtime and request id, so a retry is not executed twice.
	 * The runtime identity belongs in the key: a relaunched child starts counting its request ids
	 * from the beginning again, and answering its first report with the previous runtime's result
	 * would silently drop a report the child believes was delivered.
	 */
	readonly #served = new Map<string, unknown>();
	/** Requests being handled right now, so two copies in flight share one answer. */
	readonly #serving = new Map<string, Promise<unknown>>();
	/** Sockets that have connected but not finished their handshake, so close() can end them. */
	readonly #handshaking = new Set<Socket>();
	readonly #adoptWaiters = new Set<ConnectionWaiter>();
	readonly #eventListeners = new Set<(childId: string, event: unknown) => void>();
	readonly #connectionListeners = new Set<(childId: string, connected: boolean) => void>();
	#server: Server | undefined;
	#boundEndpoint = false;
	#requestSeq = 0;
	#closed = false;

	public constructor(options: ChildBridgeServerOptions) {
		this.#options = options;
	}

	public get endpoint(): string {
		return this.#options.endpoint;
	}

	/** Binds the endpoint, refusing one that another live bridge server still owns. */
	public async listen(): Promise<void> {
		if (this.#server !== undefined) throw new Error("bridge server is already listening");
		await this.#clearStaleEndpoint();
		const server = createServer({ allowHalfOpen: false });
		this.#server = server;
		server.on("connection", (socket) => this.#accept(socket));
		server.on("error", (error) => this.#diagnose(`socket server error: ${errorMessage(error)}`));
		const listening = new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.#options.endpoint, () => {
				server.off("error", reject);
				resolve();
			});
		});
		try {
			await listening;
		} catch (error) {
			this.#server = undefined;
			server.close();
			throw error instanceof Error ? error : new Error(errorMessage(error));
		}
		this.#boundEndpoint = true;
		await this.#restrictEndpoint();
	}

	public isConnected(childId: string): boolean {
		const connection = this.#connections.get(childId);
		return connection !== undefined && !connection.closed;
	}

	public connectedChildren(): string[] {
		return [...this.#connections.values()]
			.filter((entry) => !entry.closed)
			.map((entry) => entry.childId);
	}

	/** Sends a request to a connected child and waits for its answer. */
	public async request(
		childId: string,
		operation: string,
		payload?: unknown,
		options: ChildRequestOptions = {},
	): Promise<unknown> {
		const connection = this.#connections.get(childId);
		if (connection === undefined || connection.closed) {
			throw new BridgeError(
				"child_not_connected",
				`Child ${childId} has no live bridge connection`,
			);
		}
		if (!(BRIDGE_OPERATIONS as readonly string[]).includes(operation)) {
			// The child closes a connection that carries a frame it cannot parse, so an operation
			// outside the protocol must fail here instead of hanging until the request timeout.
			throw new BridgeError("unsupported_operation", `${operation} is not a bridge operation`);
		}
		const maxPending = this.#options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
		if (connection.pending.size >= maxPending) {
			throw new BridgeError(
				"too_many_pending_requests",
				`Child ${childId} has too many requests in flight`,
			);
		}
		const id = `bridge-${++this.#requestSeq}`;
		const timeoutMs =
			options.timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_CHILD_REQUEST_TIMEOUT_MS;
		const frame = {
			version: PROTOCOL_VERSION,
			type: "request",
			id,
			operation,
			...(payload === undefined ? {} : { payload }),
		};
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				connection.pending.delete(id);
				reject(new BridgeError("timeout", `Child ${childId} did not answer ${operation} in time`));
			}, timeoutMs);
			connection.pending.set(id, { resolve, reject, timer });
			if (this.#write(connection, frame)) return;
			// A request that never left the parent must fail now, not after the timeout.
			connection.pending.delete(id);
			clearTimeout(timer);
			reject(new BridgeError("write_failed", `Could not send ${operation} to child ${childId}`));
		});
	}

	/**
	 * Waits for a child's bridge to come up. A child that survived a parent restart reconnects on
	 * its own schedule, so adoption is a bounded wait rather than a spawn.
	 */
	public async waitForConnection(
		childId: string,
		options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
	): Promise<boolean> {
		if (this.isConnected(childId)) return true;
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (connected: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.#adoptWaiters.delete(waiter);
				options.signal?.removeEventListener("abort", onAbort);
				resolve(connected);
			};
			const waiter: ConnectionWaiter = { childId, notify: finish };
			const timer = setTimeout(() => finish(false), options.timeoutMs ?? DEFAULT_ADOPT_WAIT_MS);
			const onAbort = (): void => finish(false);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.#adoptWaiters.add(waiter);
		});
	}

	/**
	 * Ends a child's connection from this side. The parent uses it when the process stopped being the
	 * child: leaving the socket open would let a relaunch mistake the old connection for the new
	 * runtime and send into a session the parent no longer owns.
	 */
	public disconnect(childId: string): void {
		const connection = this.#connections.get(childId);
		if (connection === undefined) return;
		this.#connections.delete(childId);
		this.#drop(connection, "the child left the delegated session");
		this.#emitConnection(childId, false);
	}

	/** Subscribes to the fire-and-forget frames a child pushes: Pi events, lifecycle, input. */
	public onEvent(listener: (childId: string, event: unknown) => void): () => void {
		this.#eventListeners.add(listener);
		return () => {
			this.#eventListeners.delete(listener);
		};
	}

	/** Subscribes to connection transitions; a reconnect is what tells the parent a child is alive. */
	public onConnectionChange(listener: (childId: string, connected: boolean) => void): () => void {
		this.#connectionListeners.add(listener);
		return () => {
			this.#connectionListeners.delete(listener);
		};
	}

	#emitEvent(childId: string, event: unknown): void {
		for (const listener of [...this.#eventListeners]) {
			try {
				listener(childId, event);
			} catch (error) {
				this.#diagnose(`event listener failed: ${errorMessage(error)}`);
			}
		}
	}

	#emitConnection(childId: string, connected: boolean): void {
		for (const listener of [...this.#connectionListeners]) {
			try {
				listener(childId, connected);
			} catch (error) {
				this.#diagnose(`connection listener failed: ${errorMessage(error)}`);
			}
		}
	}

	#notifyAdopters(childId: string): void {
		for (const waiter of [...this.#adoptWaiters]) {
			if (waiter.childId === childId) waiter.notify(true);
		}
	}

	/** Closes every connection and removes the socket this server created. */
	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const connection of [...this.#connections.values()]) {
			this.#drop(connection, "bridge server is closing");
		}
		this.#connections.clear();
		// A handshake that is still waiting for its answer holds a socket that would otherwise keep
		// the server open, so teardown must end it here.
		for (const socket of [...this.#handshaking]) socket.destroy();
		this.#handshaking.clear();
		for (const waiter of [...this.#adoptWaiters]) waiter.notify(false);
		const server = this.#server;
		this.#server = undefined;
		if (server !== undefined) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
		if (!this.#boundEndpoint) return;
		this.#boundEndpoint = false;
		try {
			await unlink(this.#options.endpoint);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) {
				this.#diagnose(`could not remove endpoint: ${errorMessage(error)}`);
			}
		}
	}

	#accept(socket: Socket): void {
		let connection: ChildConnection | undefined;
		this.#handshaking.add(socket);
		const handshake = setTimeout(() => {
			if (connection !== undefined) return;
			this.#diagnose("closing a connection that never completed the bridge handshake");
			socket.destroy();
		}, HANDSHAKE_TIMEOUT_MS);
		const stop = attachJsonLineReader(socket, {
			maxFrameBytes: this.#frameLimit(),
			onValue: (value) => {
				if (connection === undefined) {
					// A child waits for `hello_ack` before sending anything else, so nothing is pipelined
					// behind the hello: the handshake can complete asynchronously without losing frames.
					void this.#handshake(socket, value).then((accepted) => {
						if (accepted === undefined) return;
						clearTimeout(handshake);
						connection = accepted;
					});
					return;
				}
				this.#receive(connection, value);
			},
			onError: (error) => {
				this.#diagnose(`bridge connection frame error: ${error.message}`);
				socket.destroy();
			},
		});
		const teardown = (): void => {
			clearTimeout(handshake);
			stop();
			this.#handshaking.delete(socket);
			const current = connection;
			if (current === undefined) return;
			connection = undefined;
			// A replaced connection already stopped being the child's connection.
			if (current.closed || this.#connections.get(current.childId) !== current) return;
			this.#connections.delete(current.childId);
			this.#drop(current, "bridge connection closed");
			this.#emitConnection(current.childId, false);
		};
		socket.on("close", teardown);
		socket.on("error", (error) => this.#diagnose(`bridge connection error: ${error.message}`));
	}

	async #handshake(socket: Socket, value: unknown): Promise<ChildConnection | undefined> {
		if (!isHelloFrame(value)) {
			this.#diagnose("refused a bridge connection with an invalid hello frame");
			socket.destroy();
			return undefined;
		}
		if (value.parentSessionId !== this.#options.parentSessionId) {
			this.#diagnose(`refused a bridge hello for another parent session: ${value.parentSessionId}`);
			socket.destroy();
			return undefined;
		}
		// The parent may need to read persisted state to answer this, so the handshake waits for it:
		// a connection is never accepted on a partially verified hello. The socket can be gone by the
		// time the answer arrives (a handshake timeout or a disconnect), and then there is nothing to
		// accept.
		const refusal = await this.#options.authorize(value);
		// The answer can arrive after the server started closing, or after the socket went away; a late
		// handshake must not create a connection that teardown is no longer waiting for.
		if (this.#closed || socket.destroyed || !this.#handshaking.has(socket)) return undefined;
		if (refusal !== undefined) {
			this.#diagnose(`refused a bridge hello for ${value.subagentId}: ${refusal}`);
			socket.destroy();
			return undefined;
		}
		const previous = this.#connections.get(value.subagentId);
		const connection: ChildConnection = {
			childId: value.subagentId,
			runtimeIdentity: value.runtimeIdentity,
			socket,
			pending: new Map(),
			closed: false,
		};
		this.#connections.set(value.subagentId, connection);
		this.#write(connection, { version: PROTOCOL_VERSION, type: "hello_ack" });
		if (previous !== undefined && previous !== connection) {
			// The child reconnected: the newer socket is the live one, the old one is stale.
			this.#drop(previous, "replaced by a newer bridge connection");
			return connection;
		}
		this.#emitConnection(connection.childId, true);
		this.#notifyAdopters(connection.childId);
		return connection;
	}

	#receive(connection: ChildConnection, value: unknown): void {
		if (isEventFrame(value)) {
			this.#emitEvent(connection.childId, value.event);
			return;
		}
		if (isResponseFrame(value)) {
			const pending = connection.pending.get(value.id);
			if (pending === undefined) return;
			connection.pending.delete(value.id);
			clearTimeout(pending.timer);
			if (value.ok) pending.resolve(value.data);
			else pending.reject(new BridgeError(value.error.code, value.error.message));
			return;
		}
		if (isRequestFrame(value)) {
			const key = this.#requestKey(connection, value.id);
			const answered = this.#served.get(key);
			if (answered !== undefined) {
				// The child did not receive the first answer, so it sent the same request again. It is
				// answered from that first result: the parent already acted on it.
				this.#write(connection, answered);
				return;
			}
			const inFlight = this.#serving.get(key);
			if (inFlight !== undefined) {
				// The same request arrived twice, either because the answer was lost or because the child
				// reconnected while the first copy was still being handled. Both askers want that one
				// result, and the one asking now gets it on the connection it is asking on.
				void inFlight.then((response) => this.#write(connection, response));
				return;
			}
			const pending = this.#serve(connection, key, value.id, value.operation, value.payload);
			this.#serving.set(key, pending);
			return;
		}
		this.#diagnose("closing a bridge connection that sent an unrecognised frame");
		connection.socket.destroy();
	}

	/**
	 * A request is identified by the runtime that sent it. A relaunched child — the same session, a
	 * new process — counts its request ids from one again, so the child alone is not an identity.
	 */
	#requestKey(connection: ChildConnection, id: string): string {
		return `${connection.childId}:${connection.runtimeIdentity}:${id}`;
	}

	/** Handles one child request and returns the frame that answers it. */
	async #serve(
		connection: ChildConnection,
		key: string,
		id: string,
		operation: string,
		payload: unknown,
	): Promise<unknown> {
		let response: unknown;
		try {
			const data = await this.#options.handleRequest({
				childId: connection.childId,
				runtimeIdentity: connection.runtimeIdentity,
				operation,
				payload,
			});
			response = successResponse(id, data);
		} catch (error) {
			const code = error instanceof BridgeError ? error.code : "bridge_error";
			response = failureResponse(id, code, errorMessage(error));
		}
		this.#serving.delete(key);
		this.#served.set(key, response);
		while (this.#served.size > MAX_SERVED_REQUESTS) {
			const oldest = this.#served.keys().next();
			if (oldest.done === true) break;
			this.#served.delete(oldest.value);
		}
		this.#write(connection, response);
		return response;
	}

	/** Reports whether the frame left the parent; a frame that did not is diagnosed. */
	#write(connection: ChildConnection, frame: unknown): boolean {
		if (connection.closed || connection.socket.destroyed) {
			this.#diagnose(`dropped a frame for child ${connection.childId}: the connection is gone`);
			return false;
		}
		let encoded: Buffer;
		try {
			encoded = serializeJsonLine(frame, this.#frameLimit());
		} catch (error) {
			this.#diagnose(
				`could not serialize a frame for child ${connection.childId}: ${errorMessage(error)}`,
			);
			return false;
		}
		connection.socket.write(encoded);
		return true;
	}

	#frameLimit(): number {
		return this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
	}

	/** Fails every request in flight for a connection that is going away. */
	#drop(connection: ChildConnection, reason: string): void {
		if (connection.closed) return;
		connection.closed = true;
		for (const [id, pending] of connection.pending) {
			connection.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(
				new BridgeError(
					"connection_lost",
					`Child ${connection.childId} connection closed: ${reason}`,
				),
			);
		}
		connection.socket.destroy();
	}

	async #clearStaleEndpoint(): Promise<void> {
		const endpoint = this.#options.endpoint;
		try {
			const stats = await lstat(endpoint);
			if (!stats.isSocket()) {
				throw new Error(`bridge endpoint path exists and is not a Unix socket: ${endpoint}`);
			}
		} catch (error) {
			if (isErrno(error, "ENOENT")) return;
			throw error instanceof Error ? error : new Error(errorMessage(error));
		}
		if (await isEndpointLive(endpoint)) {
			throw new Error(`a live bridge server already owns endpoint ${endpoint}`);
		}
		await unlink(endpoint);
		this.#diagnose(`removed stale endpoint ${endpoint}`);
	}

	async #restrictEndpoint(): Promise<void> {
		try {
			await chmod(this.#options.endpoint, 0o600);
		} catch (error) {
			this.#diagnose(`could not restrict endpoint permissions: ${errorMessage(error)}`);
		}
	}

	#diagnose(message: string): void {
		this.#options.diagnose?.(message);
	}
}

/** Probes whether something is still listening on a socket path. */
function isEndpointLive(endpoint: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(endpoint);
		const done = (live: boolean): void => {
			socket.destroy();
			resolve(live);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		setTimeout(() => done(false), 1_000).unref();
	});
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}
