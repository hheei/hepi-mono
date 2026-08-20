import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { TargetError, type TargetRuntime } from "../targets.js";
import { joinWorkspacePath } from "./paths.js";

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
		isAbsolute(path) || win32.isAbsolute(path) ? path : joinWorkspacePath(workspaceRoot, path);
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
			await rename(abs(from), abs(to));
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

function parseRemoteMeta(stdout: string): EntryMeta {
	const line = stdout.trim().split(/\r?\n/u)[0] ?? "missing 0";
	const [kind, sizeText, modeText] = line.split(" ");
	const size = Number.parseInt(sizeText ?? "0", 10);
	const mode = modeText === undefined ? undefined : Number.parseInt(modeText, 8);
	if (
		kind !== "missing" &&
		kind !== "file" &&
		kind !== "symlink" &&
		kind !== "directory" &&
		kind !== "other"
	)
		return { kind: "other", size: Number.isFinite(size) ? size : 0 };
	return {
		kind,
		size: Number.isFinite(size) ? size : 0,
		...(mode === undefined || !Number.isFinite(mode) ? {} : { mode }),
	};
}

const META_SCRIPT = (path: string, follow: boolean): string => {
	const quoted = `'${path.replaceAll("'", "'\\''")}'`;
	return follow
		? `p=${quoted}; if [ ! -e "$p" ]; then echo missing 0; elif [ -f "$p" ]; then echo file $(wc -c < "$p") $(stat -c %a "$p" 2>/dev/null || stat -f %OLp "$p"); elif [ -d "$p" ]; then echo directory 0; else echo other 0; fi`
		: `p=${quoted}; if [ -L "$p" ]; then echo symlink 0 0; elif [ -f "$p" ]; then echo file $(wc -c < "$p") $(stat -c %a "$p" 2>/dev/null || stat -f %OLp "$p"); elif [ -d "$p" ]; then echo directory 0; elif [ -e "$p" ]; then echo other 0; else echo missing 0; fi`;
};

function posixRenameUnavailable(result: {
	readonly code: number;
	readonly timedOut: boolean;
	readonly stderr: string;
}): boolean {
	return (
		result.code !== 0 &&
		!result.timedOut &&
		/unsupported|unknown command|invalid option|posix-rename|remote rename .*?: Failure/iu.test(
			result.stderr,
		)
	);
}

function sftpFail(
	phase: PublishPhase,
	result: { readonly code: number; readonly timedOut: boolean; readonly stderr: string },
	fallback: string,
): void {
	if (result.timedOut) throw new FsTransportError(phase, true, `${fallback}: timed out`);
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		if (/connection (closed|reset|timed out)|broken pipe|connection lost/iu.test(stderr))
			throw new FsTransportError(phase, false, stderr || fallback);
		throw new Error(stderr || fallback);
	}
}

export function createSftpPatchFs(runtime: TargetRuntime, alias: string): PatchFs {
	const capture = async (
		command: string,
		signal: AbortSignal | undefined,
		timeoutMs?: number,
	): Promise<string> => {
		const result = await runtime.sshCapture(alias, command, {
			...(signal === undefined ? {} : { signal }),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		});
		if (result.timedOut) throw new FsTransportError("write", true, "remote command timed out");
		if (result.code !== 0)
			throw new Error(result.stderr.trim() || `remote command failed: ${command}`);
		return result.stdout;
	};
	return {
		scope: `ssh:${alias}`,
		async lstat(path, signal) {
			return parseRemoteMeta(
				await capture(META_SCRIPT(path, false), signal, SFTP_SMALL_TIMEOUT_MS),
			);
		},
		async statFollow(path, signal) {
			return parseRemoteMeta(await capture(META_SCRIPT(path, true), signal, SFTP_SMALL_TIMEOUT_MS));
		},
		async followLeaf(path, signal) {
			const quoted = `'${path.replaceAll("'", "'\\''")}'`;
			const resolved = (
				await capture(
					`if [ -L ${quoted} ]; then realpath ${quoted}; else printf '%s' ${quoted}; fi`,
					signal,
					SFTP_SMALL_TIMEOUT_MS,
				)
			).trim();
			return resolved === "" ? path : resolved;
		},
		async readFollow(path, signal, timeoutMs) {
			try {
				return await runtime.read(alias, path, signal, timeoutMs ?? SFTP_SMALL_TIMEOUT_MS);
			} catch (error) {
				if (error instanceof TargetError && error.outcome === "timeout")
					throw new FsTransportError("write", true, error.message);
				if (error instanceof TargetError && error.outcome === "cancelled")
					throw new FsTransportError("write", false, error.message);
				throw error;
			}
		},
		async mkdirp(path, signal) {
			await capture(
				`mkdir -p ${`'${path.replaceAll("'", "'\\''")}'`}`,
				signal,
				SFTP_SMALL_TIMEOUT_MS,
			);
		},
		async writeAtomic(path, data, mode, signal) {
			const local = join(tmpdir(), `hepi-apply-patch-put-${randomUUID()}`);
			try {
				await writeFile(local, data, mode === undefined ? undefined : { mode });
				const result = await runtime.sftpPut(alias, local, path, {
					...(signal === undefined ? {} : { signal }),
					timeoutMs: sftpTimeoutMs(data.length),
				});
				sftpFail("write", result, "SFTP put failed");
			} finally {
				await rm(local, { force: true }).catch(() => undefined);
			}
		},
		async renameNew(from, to, signal) {
			const result = await runtime.sftpRename(alias, from, to, false, {
				...(signal === undefined ? {} : { signal }),
				timeoutMs: SFTP_SMALL_TIMEOUT_MS,
			});
			sftpFail("replace", result, "SFTP rename failed");
		},
		async replace(from, to, signal) {
			const options = {
				...(signal === undefined ? {} : { signal }),
				timeoutMs: SFTP_SMALL_TIMEOUT_MS,
			};
			let result = await runtime.sftpRename(alias, from, to, true, options);
			if (posixRenameUnavailable(result))
				result = await runtime.sftpRename(alias, from, to, false, options);
			if (posixRenameUnavailable(result)) throw new Error("atomic_replace_unsupported");
			sftpFail("replace", result, "SFTP replace failed");
		},
		async unlink(path, signal) {
			const result = await runtime.sftpRm(alias, path, {
				...(signal === undefined ? {} : { signal }),
				timeoutMs: SFTP_SMALL_TIMEOUT_MS,
			});
			sftpFail("remove", result, "SFTP rm failed");
		},
		async list(path, signal) {
			const result = await runtime.sshCapture(
				alias,
				`ls -A ${path === "" || path === "." ? "." : `'${path.replaceAll("'", "'\\''")}'`} 2>/dev/null || true`,
				{
					...(signal === undefined ? {} : { signal }),
					timeoutMs: SFTP_SMALL_TIMEOUT_MS,
				},
			);
			if (result.timedOut) throw new FsTransportError("write", true, "remote ls timed out");
			return result.stdout.split(/\r?\n/u).filter(Boolean);
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
