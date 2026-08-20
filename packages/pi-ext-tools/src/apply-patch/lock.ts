import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ApplyPatchBusyError extends Error {
	readonly code = "APPLY_PATCH_BUSY";
	constructor(scope: string) {
		super(`apply_patch is already running for ${scope}`);
		this.name = "ApplyPatchBusyError";
	}
}

function hashKey(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function applyPatchLockPath(key: string): string {
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

/** Exclusive apply_patch lock. Busy rejects immediately; kernel-held, released on process death. */
export async function acquireApplyPatchLock(key: string): Promise<() => Promise<void>> {
	const path = applyPatchLockPath(key);
	try {
		return release(await listen(path), path);
	} catch (error) {
		if (!isAddrInUse(error)) throw error;
		if (await canConnect(path)) throw new ApplyPatchBusyError(key);
		if (process.platform !== "win32") await unlink(path).catch(() => undefined);
		try {
			return release(await listen(path), path);
		} catch (retryError) {
			if (isAddrInUse(retryError)) throw new ApplyPatchBusyError(key);
			throw retryError;
		}
	}
}
