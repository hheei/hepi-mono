import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { defaultPiSettingsPaths } from "@hheei/pi-ext-core";
import { coordinatorSocketPath } from "./coordinator-client.js";
import { type ApplyPatchInWorkspaceResult, applyPatchInWorkspace } from "./executor.js";
import { parseV4aPatch } from "./parser.js";
import { type FuzzyApplyPatchPolicy, loadFuzzyApplyPatchPolicy } from "./policy.js";

interface ApplyRequest {
	readonly type: "apply";
	readonly id: string;
	readonly workspaceRoot: string;
	readonly patch: string;
}
interface QueueItem {
	readonly request: ApplyRequest;
	readonly socket: Socket;
	readonly abort: AbortController;
	readonly locks: readonly string[];
}
interface RunningItem {
	readonly item: QueueItem;
	readonly abort: AbortController;
}
type ApplyResponse =
	| { readonly id: string; readonly ok: true; readonly result: ApplyPatchInWorkspaceResult }
	| { readonly id: string; readonly ok: false; readonly error: string };

const COORDINATOR_IDLE_TIMEOUT_MS = 30_000;

function isApplyRequest(value: unknown): value is ApplyRequest {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const r: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) r[key] = item;
	if (
		Object.keys(r).some(
			(key) => key !== "type" && key !== "id" && key !== "workspaceRoot" && key !== "patch",
		)
	)
		return false;
	return (
		r.type === "apply" &&
		typeof r.id === "string" &&
		typeof r.workspaceRoot === "string" &&
		typeof r.patch === "string"
	);
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function send(socket: Socket, response: ApplyResponse): void {
	if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

function isMissingPath(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		return code !== "ESRCH";
	}
}

async function acquireCoordinatorLock(lockPath: string): Promise<void> {
	try {
		await writeFile(lockPath, String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 });
		return;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code !== "EEXIST") throw error;
	}
	const existing = await readFile(lockPath, "utf8").catch((error: unknown) => {
		if (isMissingPath(error)) return "";
		throw error;
	});
	const pid = Number(existing.trim());
	if (Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid))
		throw new Error("Apply patch coordinator is already starting or running");
	await unlink(lockPath).catch((error: unknown) => {
		if (!isMissingPath(error)) throw error;
	});
	await writeFile(lockPath, String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function startApplyPatchCoordinatorServer(workspaceRootInput: string): Promise<void> {
	const workspaceRoot = await realpath(workspaceRootInput);
	const socketPath = coordinatorSocketPath(workspaceRoot);
	const lockPath = `${socketPath}.lock`;
	await acquireCoordinatorLock(lockPath);
	let policy: FuzzyApplyPatchPolicy;
	try {
		policy = await loadFuzzyApplyPatchPolicy({ paths: defaultPiSettingsPaths(workspaceRoot) });
		await unlink(socketPath).catch((error: unknown) => {
			if (!isMissingPath(error)) throw error;
		});
	} catch (error) {
		await unlink(lockPath).catch(() => undefined);
		throw error;
	}
	const pending: QueueItem[] = [];
	const running: RunningItem[] = [];
	const activeLocks = new Set<string>();
	let active = 0;
	let idleTimer: NodeJS.Timeout | undefined;
	const scheduleIdleShutdown = (): void => {
		if (active > 0 || pending.length > 0 || idleTimer !== undefined) return;
		idleTimer = setTimeout(() => void server.close(), COORDINATOR_IDLE_TIMEOUT_MS);
	};
	const server = createServer((socket) => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
		let data = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			data += chunk;
			const newline = data.indexOf("\n");
			if (newline < 0) return;
			const line = data.slice(0, newline);
			data = data.slice(newline + 1);
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				send(socket, { id: "", ok: false, error: "Invalid JSON request" });
				return;
			}
			if (!isApplyRequest(value) || value.workspaceRoot !== workspaceRoot) {
				send(socket, {
					id: isApplyRequest(value) ? value.id : "",
					ok: false,
					error: "Invalid apply patch request",
				});
				return;
			}
			let locks: readonly string[];
			try {
				const parsed = parseV4aPatch(value.patch);
				locks = [
					...new Set(
						parsed.operations.flatMap((op) =>
							op.kind === "update" && op.moveTo !== undefined ? [op.path, op.moveTo] : [op.path],
						),
					),
				].sort();
			} catch (error) {
				send(socket, { id: value.id, ok: false, error: errorText(error) });
				return;
			}
			if (pending.length >= policy.maxQueueDepth) {
				send(socket, { id: value.id, ok: false, error: "Apply patch coordinator queue is full" });
				return;
			}
			const item: QueueItem = { request: value, socket, abort: new AbortController(), locks };
			pending.push(item);
			if (idleTimer !== undefined) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
			pump();
		});
		socket.on("close", () => {
			for (let index = pending.length - 1; index >= 0; index -= 1) {
				const item = pending[index];
				if (item?.socket !== socket) continue;
				item.abort.abort(new Error("Apply patch client disconnected"));
				pending.splice(index, 1);
			}
			for (const item of running)
				if (item.item.socket === socket)
					item.abort.abort(new Error("Apply patch client disconnected"));
			scheduleIdleShutdown();
		});
	});
	const pump = (): void => {
		for (let index = 0; index < pending.length && active < policy.maxConcurrentWorkers; ) {
			const item = pending[index];
			if (item === undefined || item.locks.some((lock) => activeLocks.has(lock))) {
				index += 1;
				continue;
			}
			pending.splice(index, 1);
			for (const lock of item.locks) activeLocks.add(lock);
			active += 1;
			running.push({ item, abort: item.abort });
			void applyPatchInWorkspace({
				workspaceRoot,
				patch: item.request.patch,
				policy,
				signal: item.abort.signal,
			})
				.then(
					(result) => send(item.socket, { id: item.request.id, ok: true, result }),
					(error) => send(item.socket, { id: item.request.id, ok: false, error: errorText(error) }),
				)
				.finally(() => {
					const runningIndex = running.findIndex((entry) => entry.item === item);
					if (runningIndex >= 0) running.splice(runningIndex, 1);
					for (const lock of item.locks) activeLocks.delete(lock);
					active -= 1;
					pump();
					scheduleIdleShutdown();
				});
		}
	};
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, () => listening.resolve());
	await listening.promise;
	scheduleIdleShutdown();
	const cleanup = (): void => {
		void unlink(socketPath).catch(() => undefined);
		void unlink(lockPath).catch(() => undefined);
	};
	server.once("close", cleanup);
	process.once("exit", cleanup);
	process.once("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});
	process.once("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = process.argv[2];
	if (root === undefined) {
		process.stderr.write("Missing workspace root\n");
		process.exit(1);
	} else
		void startApplyPatchCoordinatorServer(root).catch((error: unknown) => {
			process.stderr.write(`${errorText(error)}\n`);
			process.exit(1);
		});
}
