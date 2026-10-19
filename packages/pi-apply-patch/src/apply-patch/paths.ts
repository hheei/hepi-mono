import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { MAX_V4A_PATH_BYTES, MAX_V4A_PATH_SEGMENT_BYTES } from "./parser.js";

export function assertPatchPath(path: string): void {
	if (!path || path.includes("\0")) throw new Error(`Invalid patch path: ${path}`);
	if (Buffer.byteLength(path, "utf8") > MAX_V4A_PATH_BYTES)
		throw new Error(`Patch path exceeds ${MAX_V4A_PATH_BYTES} byte limit: ${path}`);
	const segments = path.split(/[\\/]/u);
	if (segments.some((segment) => Buffer.byteLength(segment, "utf8") > MAX_V4A_PATH_SEGMENT_BYTES))
		throw new Error(`Patch path segment exceeds ${MAX_V4A_PATH_SEGMENT_BYTES} byte limit: ${path}`);
}

/** Resolves relative paths from the workspace without following symlinks. */
export function resolvePatchPath(workspaceRoot: string, path: string): string {
	assertPatchPath(path);
	return isAbsolute(path) || win32.isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

/** Lexically detects confirmed local writes outside the workspace. */
export function isPatchPathOutsideWorkspace(workspaceRoot: string, path: string): boolean {
	const workspace = resolve(workspaceRoot);
	const target = resolvePatchPath(workspace, path);
	const fromWorkspace = relative(workspace, target);
	return (
		fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)
	);
}
