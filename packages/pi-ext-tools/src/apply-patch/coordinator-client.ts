import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplyPatchInWorkspaceResult } from "./executor.js";

export interface ApplyPatchThroughCoordinatorOptions {
	readonly workspaceRoot: string;
	readonly patch: string;
	readonly signal?: AbortSignal;
}

interface ApplyResponse {
	readonly id: string;
	readonly ok: boolean;
	readonly result?: ApplyPatchInWorkspaceResult;
	readonly error?: string;
}

const startupPromises = new Map<string, Promise<void>>();

export function coordinatorSocketPath(workspaceRoot: string): string {
	const digest = createHash("sha256").update(workspaceRoot).digest("hex");
	return join(tmpdir(), `hepi-apply-patch-${digest}.sock`);
}

function isApplyResponse(value: unknown): value is ApplyResponse {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) record[key] = item;
	if (
		Object.keys(record).some(
			(key) => key !== "id" && key !== "ok" && key !== "result" && key !== "error",
		)
	)
		return false;
	if (typeof record.id !== "string" || typeof record.ok !== "boolean") return false;
	if (record.error !== undefined && typeof record.error !== "string") return false;
	if (record.ok && record.error !== undefined) return false;
	if (!record.ok && record.result !== undefined) return false;
	if (record.result === undefined) return !record.ok;
	if (record.result === null || typeof record.result !== "object" || Array.isArray(record.result))
		return false;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record.result)) result[key] = item;
	return (
		Object.keys(result).every(
			(key) =>
				key === "changedPaths" ||
				key === "operationCount" ||
				key === "exactUpdateCount" ||
				key === "fuzzyUpdateCount",
		) &&
		Array.isArray(result.changedPaths) &&
		result.changedPaths.every((path) => typeof path === "string") &&
		Number.isInteger(result.operationCount) &&
		Number.isInteger(result.exactUpdateCount) &&
		Number.isInteger(result.fuzzyUpdateCount)
	);
}

function connectOnce(
	socketPath: string,
	request: string,
	signal?: AbortSignal,
): Promise<ApplyResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<ApplyResponse>();
	let settled = false;
	let buffer = "";
	let socket: Socket | undefined;
	const finish = (callback: () => void): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", abort);
		callback();
	};
	const abort = (): void => {
		socket?.destroy();
		finish(() => reject(signal?.reason ?? new Error("Apply patch coordinator aborted")));
	};
	signal?.throwIfAborted();
	socket = connect(socketPath);
	socket.setEncoding("utf8");
	socket.on("connect", () => socket?.write(`${request}\n`));
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline);
		try {
			const value: unknown = JSON.parse(line);
			if (!isApplyResponse(value)) throw new Error("Invalid response from apply patch coordinator");
			finish(() => resolve(value));
			socket?.end();
		} catch (error) {
			finish(() => reject(error));
		}
	});
	socket.on("error", (error) => finish(() => reject(error)));
	socket.on("close", () =>
		finish(() => reject(new Error("Apply patch coordinator closed connection"))),
	);
	signal?.addEventListener("abort", abort, { once: true });
	return promise;
}

function waitForCoordinator(socketPath: string, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let socket: Socket | undefined;
	const finish = (callback: () => void): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", abort);
		callback();
	};
	const abort = (): void => {
		socket?.destroy();
		finish(() => reject(signal?.reason ?? new Error("Apply patch coordinator startup aborted")));
	};
	signal?.throwIfAborted();
	socket = connect(socketPath);
	socket.on("connect", () =>
		finish(() => {
			socket?.end();
			resolve();
		}),
	);
	socket.on("error", (error) => finish(() => reject(error)));
	signal?.addEventListener("abort", abort, { once: true });
	return promise;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function ensureServer(
	workspaceRoot: string,
	socketPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const existing = startupPromises.get(socketPath);
	if (existing !== undefined) return existing;
	const startup = (async (): Promise<void> => {
		const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
		const modulePath = fileURLToPath(new URL(`./coordinator-server.${extension}`, import.meta.url));
		const child = spawn(process.execPath, [modulePath, workspaceRoot], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		let lastError: unknown;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			signal?.throwIfAborted();
			try {
				await waitForCoordinator(socketPath, signal);
				return;
			} catch (error) {
				lastError = error;
				await delay(25);
			}
		}
		throw new Error(`Apply patch coordinator startup failed: ${String(lastError)}`);
	})();
	startupPromises.set(socketPath, startup);
	try {
		await startup;
	} finally {
		startupPromises.delete(socketPath);
	}
}

export async function applyPatchThroughCoordinator(
	options: ApplyPatchThroughCoordinatorOptions,
): Promise<ApplyPatchInWorkspaceResult> {
	options.signal?.throwIfAborted();
	const workspaceRoot = await realpath(options.workspaceRoot);
	const socketPath = coordinatorSocketPath(workspaceRoot);
	const id = randomUUID();
	const request = JSON.stringify({ type: "apply", id, workspaceRoot, patch: options.patch });
	let response: ApplyResponse;
	try {
		response = await connectOnce(socketPath, request, options.signal);
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		await ensureServer(workspaceRoot, socketPath, options.signal);
		response = await connectOnce(socketPath, request, options.signal);
	}
	if (response.id !== id) throw new Error("Apply patch coordinator response id mismatch");
	if (!response.ok) throw new Error(response.error ?? "Apply patch coordinator rejected request");
	if (response.result === undefined) throw new Error("Apply patch coordinator returned no result");
	return response.result;
}
