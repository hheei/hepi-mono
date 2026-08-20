import { isAbsolute, join, win32 } from "node:path";
import { MAX_V4A_PATH_BYTES, MAX_V4A_PATH_SEGMENT_BYTES } from "./parser.js";

export interface ValidatedPatchPath {
	readonly relativePath: string;
	readonly absolutePath: string;
}

/** Lexical workspace membership only. Symlinks are not a jail. */
export function assertPatchPath(path: string): void {
	if (!path || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path))
		throw new Error(`Patch path must be a relative workspace path: ${path}`);
	if (path.includes("\\")) throw new Error(`Patch path must use forward slashes: ${path}`);
	if (Buffer.byteLength(path, "utf8") > MAX_V4A_PATH_BYTES)
		throw new Error(`Patch path exceeds ${MAX_V4A_PATH_BYTES} byte limit: ${path}`);
	const segments = path.split("/");
	if (segments.some((segment) => Buffer.byteLength(segment, "utf8") > MAX_V4A_PATH_SEGMENT_BYTES))
		throw new Error(`Patch path segment exceeds ${MAX_V4A_PATH_SEGMENT_BYTES} byte limit: ${path}`);
	if (segments.some((segment) => !segment || segment === "." || segment === ".."))
		throw new Error(`Patch path must not contain empty, '.' or '..' segments: ${path}`);
}

export function joinWorkspacePath(workspaceRoot: string, path: string): string {
	assertPatchPath(path);
	return join(workspaceRoot, ...path.split("/"));
}

/** Validates one patch path lexically against a workspace root before any mutation. */
export async function validatePatchPath(
	workspaceRoot: string,
	path: string,
): Promise<ValidatedPatchPath> {
	return {
		relativePath: path,
		absolutePath: joinWorkspacePath(workspaceRoot, path),
	};
}
