import { Buffer } from "node:buffer";
import {
	APPLY_PATCH_MAX_FILE_SIZE,
	acquireMutationLock,
	createSftpPatchFs,
	FsTransportError,
	fileTooLarge,
	gcAgentPatchTemps,
	MutationBusyError,
	type PatchFs,
	publishPreparedFile,
	sftpTimeoutMs,
} from "./apply-patch/index.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { LOCAL_TARGET, OUTPUT_TARGET } from "./targets.js";

export const REMOTE_MUTATION_DETAILS = "__piExtToolsRemoteMutation";

export type RemoteMutationOutcome =
	| "changed"
	| "no_change"
	| "rejected"
	| "unconfirmed"
	| "not_applied";

export interface RemoteMutationDetails {
	readonly target: string;
	readonly path: string;
	readonly outcome: RemoteMutationOutcome;
	readonly error?: string;
}

export type ExactEditOperation = {
	readonly oldText: string;
	readonly newText: string;
};

export type RemoteWriteData = {
	readonly existed: boolean;
	readonly before?: Uint8Array;
};

export type RemoteEditData = {
	readonly before: string;
	readonly after: string;
};

type RemoteMutationSuccess<T> = T & {
	readonly target: string;
	readonly path: string;
	readonly outcome: "changed" | "no_change";
};

type RemoteMutationFailure = RemoteMutationDetails & {
	readonly outcome: "rejected" | "unconfirmed" | "not_applied";
	readonly error: string;
};

export type RemoteMutationResult<T> = RemoteMutationSuccess<T> | RemoteMutationFailure;

type RemoteMutationOperation<T> = (
	fs: PatchFs,
) => Promise<T & { readonly outcome: "changed" | "no_change" }>;

function parentDir(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "." : path.slice(0, index);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function failedOutcome(
	error: unknown,
	signal: AbortSignal | undefined,
): RemoteMutationFailure["outcome"] {
	if (error instanceof FsTransportError)
		return error.phase === "write" ? "not_applied" : "unconfirmed";
	return signal?.aborted === true ? "not_applied" : "rejected";
}

function remoteFs(state: FffRuntimeState | undefined, target: string, path: string): PatchFs {
	if (target === LOCAL_TARGET) throw new Error("Local targets must use the Pi native executor.");
	if (target === OUTPUT_TARGET) throw new Error("write and edit do not support output targets.");
	const runtime = state?.getTargetRuntime();
	if (runtime === undefined) throw new Error("Target runtime is unavailable.");
	if (!runtime.isAllowedHost(target))
		throw new Error(`Unknown or unauthorized SSH target: ${target}`);
	runtime.validateRemotePath(path);
	return createSftpPatchFs(runtime, target);
}

async function mutateRemote<T>(
	state: FffRuntimeState | undefined,
	target: string,
	path: string,
	signal: AbortSignal | undefined,
	operation: RemoteMutationOperation<T>,
): Promise<RemoteMutationResult<T>> {
	const fs = remoteFs(state, target, path);
	const release = await acquireMutationLock(fs.scope, signal);
	try {
		await gcAgentPatchTemps(fs, [parentDir(path)], signal);
		const result = await operation(fs);
		return { ...result, target, path };
	} catch (error) {
		if (error instanceof MutationBusyError) throw error;
		return {
			target,
			path,
			outcome: failedOutcome(error, signal),
			error: errorMessage(error),
		};
	} finally {
		await release();
	}
}

export function remoteMutationDetails(value: unknown): RemoteMutationDetails | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const details = (value as Record<string, unknown>)[REMOTE_MUTATION_DETAILS];
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const record = details as Record<string, unknown>;
	const outcome = record.outcome;
	if (
		typeof record.target !== "string" ||
		typeof record.path !== "string" ||
		(outcome !== "changed" &&
			outcome !== "no_change" &&
			outcome !== "rejected" &&
			outcome !== "unconfirmed" &&
			outcome !== "not_applied")
	)
		return undefined;
	return {
		target: record.target,
		path: record.path,
		outcome,
		...(typeof record.error === "string" ? { error: record.error } : {}),
	};
}

export function isNativeRemoteMutationDetails(value: unknown): value is {
	readonly [REMOTE_MUTATION_DETAILS]: RemoteMutationDetails;
} {
	return remoteMutationDetails(value) !== undefined;
}

export async function writeRemoteFile(
	state: FffRuntimeState | undefined,
	target: string,
	path: string,
	content: string,
	signal: AbortSignal | undefined,
): Promise<RemoteMutationResult<RemoteWriteData>> {
	const bytes = Buffer.from(content, "utf8");
	return await mutateRemote(state, target, path, signal, async (fs) => {
		if (bytes.length > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(bytes.length, path);
		const entry = await fs.lstat(path, signal);
		if (entry.kind === "missing") {
			await publishPreparedFile(fs, path, bytes, undefined, false, signal);
			return { outcome: "changed", existed: false };
		}
		if (entry.kind === "directory" || entry.kind === "other")
			throw new Error(`Cannot write to non-file path: ${path}`);

		const followed = await fs.statFollow(path, signal);
		if (followed.kind === "missing") {
			// Pi native write atomically replaces a dangling leaf symlink.
			await publishPreparedFile(fs, path, bytes, undefined, true, signal);
			return { outcome: "changed", existed: false };
		}
		if (followed.kind !== "file") throw new Error(`Cannot write to non-file path: ${path}`);
		if (followed.size > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(followed.size, path);
		const before = await fs.readFollow(path, signal, sftpTimeoutMs(followed.size));
		if (before.length > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(before.length, path);
		if (Buffer.compare(before, bytes) === 0) return { outcome: "no_change", existed: true, before };
		const destination = await fs.followLeaf(path, signal);
		await publishPreparedFile(fs, destination, bytes, followed.mode, true, signal);
		return { outcome: "changed", existed: true, before };
	});
}

export function applyExactEdits(
	path: string,
	before: string,
	edits: readonly ExactEditOperation[],
): string {
	if (edits.length === 0)
		throw new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	const ranges = edits.map((edit, index) => {
		const first = before.indexOf(edit.oldText);
		if (first < 0) throw new Error(`Could not find the exact text for edits[${index}] in ${path}.`);
		const second = before.indexOf(edit.oldText, first + edit.oldText.length);
		if (second >= 0)
			throw new Error(
				`Found 2 occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
			);
		return { ...edit, index, start: first, end: first + edit.oldText.length };
	});
	const ordered = [...ranges].sort((left, right) => left.start - right.start);
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (previous !== undefined && current !== undefined && current.start < previous.end)
			throw new Error(`edits[${current.index}] overlaps edits[${previous.index}] in ${path}.`);
	}
	let after = before;
	for (const range of [...ranges].sort((left, right) => right.start - left.start))
		after = `${after.slice(0, range.start)}${range.newText}${after.slice(range.end)}`;
	return after;
}

export async function editRemoteFile(
	state: FffRuntimeState | undefined,
	target: string,
	path: string,
	edits: readonly ExactEditOperation[],
	signal: AbortSignal | undefined,
): Promise<RemoteMutationResult<RemoteEditData>> {
	return await mutateRemote(state, target, path, signal, async (fs) => {
		const followed = await fs.statFollow(path, signal);
		if (followed.kind === "missing")
			throw new Error(`Could not edit file: ${path}. Error code: ENOENT.`);
		if (followed.kind !== "file")
			throw new Error(`Could not edit file: ${path}. Path is not a regular file.`);
		if (followed.size > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(followed.size, path);
		const beforeBytes = await fs.readFollow(path, signal, sftpTimeoutMs(followed.size));
		if (beforeBytes.length > APPLY_PATCH_MAX_FILE_SIZE)
			throw fileTooLarge(beforeBytes.length, path);
		const before = new TextDecoder().decode(beforeBytes);
		const after = applyExactEdits(path, before, edits);
		if (after === before) return { outcome: "no_change", before, after };
		const afterBytes = Buffer.from(after, "utf8");
		if (afterBytes.length > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(afterBytes.length, path);
		const destination = await fs.followLeaf(path, signal);
		await publishPreparedFile(fs, destination, afterBytes, followed.mode, true, signal);
		return { outcome: "changed", before, after };
	});
}
