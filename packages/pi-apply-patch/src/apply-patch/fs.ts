import { randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, win32 } from "node:path";
import { resolvePatchPath } from "./paths.js";

export const APPLY_PATCH_MAX_FILE_SIZE = 32 * 1024 * 1024;
export const SFTP_SMALL_BYTES = 1_048_576;
export const SFTP_SMALL_TIMEOUT_MS = 30_000;
export const SFTP_LARGE_TIMEOUT_MS = 60_000;

const TEMP_RE = /^\..+\.agentpatch-[0-9a-f-]{36}\.tmp$/iu;

export type EntryKind = "missing" | "file" | "symlink" | "directory" | "other";

export interface EntryMeta {
	readonly kind: EntryKind;
	readonly size: number;
	readonly mode?: number;
}

export type PublishPhase = "write" | "replace" | "remove";

export class FsTransportError extends Error {
	readonly phase: PublishPhase;
	readonly timedOut: boolean;
	constructor(phase: PublishPhase, timedOut: boolean, message: string) {
		super(message);
		this.name = "FsTransportError";
		this.phase = phase;
		this.timedOut = timedOut;
	}
}

export interface PatchFs {
	readonly scope: string;
	lstat(path: string, signal?: AbortSignal): Promise<EntryMeta>;
	statFollow(path: string, signal?: AbortSignal): Promise<EntryMeta>;
	followLeaf(path: string, signal?: AbortSignal): Promise<string>;
	readFollow(path: string, signal?: AbortSignal, timeoutMs?: number): Promise<Uint8Array>;
	mkdirp(path: string, signal?: AbortSignal): Promise<void>;
	writeAtomic(
		path: string,
		data: Uint8Array,
		mode: number | undefined,
		signal?: AbortSignal,
	): Promise<void>;
	renameNew(from: string, to: string, signal?: AbortSignal): Promise<void>;
	replace(from: string, to: string, signal?: AbortSignal): Promise<void>;
	unlink(path: string, signal?: AbortSignal): Promise<void>;
	list(path: string, signal?: AbortSignal): Promise<readonly string[]>;
}

export function sftpTimeoutMs(bytes: number): number {
	return bytes <= SFTP_SMALL_BYTES ? SFTP_SMALL_TIMEOUT_MS : SFTP_LARGE_TIMEOUT_MS;
}

export function agentPatchTempName(base: string): string {
	return `.${base}.agentpatch-${randomUUID()}.tmp`;
}

export function isAgentPatchTemp(name: string): boolean {
	return TEMP_RE.test(name);
}

export function fileTooLarge(size: number, path: string): Error {
	return new Error(
		`file_too_large (${size} > ${APPLY_PATCH_MAX_FILE_SIZE}) at ${path}; use another tool suitable for large-file edits.`,
	);
}

/** Installs fully prepared bytes through one sibling temporary file. */
export async function publishPreparedFile(
	fs: PatchFs,
	path: string,
	data: Uint8Array,
	mode: number | undefined,
	replaceExisting: boolean,
	signal?: AbortSignal,
	beforePublish?: () => Promise<void>,
): Promise<void> {
	const slash = path.lastIndexOf("/");
	const directory = slash < 0 ? "." : path.slice(0, slash);
	if (directory !== ".") await fs.mkdirp(directory, signal);
	const base = slash < 0 ? path : path.slice(slash + 1);
	const temp = `${directory === "." ? "" : `${directory}/`}${agentPatchTempName(base)}`;
	try {
		await fs.writeAtomic(temp, data, mode, signal);
		await beforePublish?.();
		if (replaceExisting) await fs.replace(temp, path, signal);
		else await fs.renameNew(temp, path, signal);
	} catch (error) {
		if (!(error instanceof FsTransportError) || error.phase === "write")
			await fs.unlink(temp).catch(() => undefined);
		throw error;
	}
}

function isMissing(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function localMeta(
	info: {
		isSymbolicLink(): boolean;
		isFile(): boolean;
		isDirectory(): boolean;
		size: number;
		mode: number;
	},
	kindOverride?: EntryKind,
): EntryMeta {
	const kind =
		kindOverride ??
		(info.isSymbolicLink()
			? "symlink"
			: info.isFile()
				? "file"
				: info.isDirectory()
					? "directory"
					: "other");
	return {
		kind,
		size: info.size,
		mode: info.mode & 0o7777,
	};
}

export function createLocalPatchFs(workspaceRoot: string): PatchFs {
	const abs = (path: string): string =>
		isAbsolute(path) || win32.isAbsolute(path) ? path : resolvePatchPath(workspaceRoot, path);
	return {
		scope: workspaceRoot,
		async lstat(path, signal) {
			signal?.throwIfAborted();
			try {
				return localMeta(await lstat(abs(path)));
			} catch (error) {
				if (isMissing(error)) return { kind: "missing", size: 0 };
				throw error;
			}
		},
		async statFollow(path, signal) {
			signal?.throwIfAborted();
			try {
				const info = await stat(abs(path));
				return localMeta(info, info.isFile() ? "file" : info.isDirectory() ? "directory" : "other");
			} catch (error) {
				if (isMissing(error)) return { kind: "missing", size: 0 };
				throw error;
			}
		},
		async followLeaf(path, signal) {
			signal?.throwIfAborted();
			const current = abs(path);
			try {
				const info = await lstat(current);
				if (!info.isSymbolicLink()) return path;
				return await realpath(current);
			} catch (error) {
				if (isMissing(error)) return path;
				throw error;
			}
		},
		async readFollow(path, signal) {
			return await readFile(abs(path), signal === undefined ? undefined : { signal });
		},
		async mkdirp(path, signal) {
			signal?.throwIfAborted();
			await mkdir(abs(path), { recursive: true });
		},
		async writeAtomic(path, data, mode, signal) {
			signal?.throwIfAborted();
			const target = abs(path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, data, {
				...(signal === undefined ? {} : { signal }),
				...(mode === undefined ? {} : { mode }),
			});
		},
		async renameNew(from, to, signal) {
			signal?.throwIfAborted();
			await link(abs(from), abs(to));
			await unlink(abs(from)).catch(() => undefined);
		},
		async replace(from, to, signal) {
			if (signal?.aborted) throw new FsTransportError("replace", false, "cancelled before replace");
			try {
				await rename(abs(from), abs(to));
			} catch (error) {
				if (signal?.aborted)
					throw new FsTransportError("replace", false, "cancelled during replace");
				throw error;
			}
		},
		async unlink(path, signal) {
			if (signal?.aborted) throw new FsTransportError("remove", false, "cancelled before remove");
			try {
				await unlink(abs(path));
			} catch (error) {
				if (signal?.aborted) throw new FsTransportError("remove", false, "cancelled during remove");
				throw error;
			}
		},
		async list(path) {
			try {
				return await readdir(path === "" || path === "." ? workspaceRoot : abs(path));
			} catch (error) {
				if (isMissing(error)) return [];
				throw error;
			}
		},
	};
}

export async function gcAgentPatchTemps(
	fs: PatchFs,
	directories: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	const seen = new Set<string>();
	for (const directory of directories) {
		const key = directory === "" ? "." : directory;
		if (seen.has(key)) continue;
		seen.add(key);
		const names = await fs.list(key, signal);
		for (const name of names) {
			if (!isAgentPatchTemp(name)) continue;
			const path = key === "." ? name : `${key}/${name}`;
			await fs.unlink(path, signal).catch(() => undefined);
		}
	}
}
