import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class MutationBusyError extends Error {
	readonly code = "MUTATION_BUSY";
	constructor(scope: string) {
		super(`A mutation is already running for ${scope}`);
		this.name = "MutationBusyError";
	}
}

function hashKey(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function mutationLockPath(key: string): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\hepi-apply-patch-${hashKey(key)}`;
	return join(tmpdir(), `hepi-apply-patch-${hashKey(key)}.sock`);
}

function isAddrInUse(error: unknown): boolean {
	return (
		error !== null && typeof error === "object" && "code" in error && error.code === "EADDRINUSE"
	);
}

async function listen(path: string): Promise<Server> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		const fail = (error: Error): void => reject(error);
		server.once("error", fail);
		server.listen(path, () => {
			server.removeListener("error", fail);
			resolve();
		});
	});
	return server;
}

async function canConnect(path: string): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = createConnection(path);
		const done = (ok: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(500);
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.once("timeout", () => done(false));
	});
}

function release(server: Server, path: string): () => Promise<void> {
	return async (): Promise<void> => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (process.platform !== "win32") await unlink(path).catch(() => undefined);
	};
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

async function waitUntilReleased(path: string, signal?: AbortSignal): Promise<void> {
	while (await canConnect(path)) {
		throwIfAborted(signal);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, 25);
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
			};
			if (signal === undefined) return;
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

/** Exclusive mutation lock. Waiters queue until the holder releases or the waiter aborts. Kernel-held, released on process death. */
export async function acquireMutationLock(
	key: string,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	const path = mutationLockPath(key);
	for (;;) {
		throwIfAborted(signal);
		try {
			return release(await listen(path), path);
		} catch (error) {
			if (!isAddrInUse(error)) throw error;
			if (await canConnect(path)) {
				await waitUntilReleased(path, signal);
				continue;
			}
			if (process.platform !== "win32") await unlink(path).catch(() => undefined);
		}
	}
}

export async function withMutationLock<T>(
	key: string,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const unlock = await acquireMutationLock(key, signal);
	try {
		return await run();
	} finally {
		await unlock();
	}
}
