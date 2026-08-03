import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep, win32 } from "node:path";

export interface ValidatedPatchPath {
	readonly relativePath: string;
	readonly absolutePath: string;
}

function isMissingPath(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function assertPatchPath(path: string): void {
	if (!path || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path))
		throw new Error(`Patch path must be a relative workspace path: ${path}`);
	if (path.includes("\\")) throw new Error(`Patch path must use forward slashes: ${path}`);
	const segments = path.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".."))
		throw new Error(`Patch path must not contain empty, '.' or '..' segments: ${path}`);
}

async function assertNoSymlink(root: string, relativePath: string): Promise<void> {
	let current = root;
	for (const segment of relativePath.split("/")) {
		current = join(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Patch path traverses a symbolic link: ${relativePath}`);
		} catch (error) {
			if (isMissingPath(error)) return;
			throw error;
		}
	}
}

/** Validates one patch path against a canonical workspace root before any mutation. */
export async function validatePatchPath(
	workspaceRoot: string,
	path: string,
): Promise<ValidatedPatchPath> {
	assertPatchPath(path);
	const root = await realpath(workspaceRoot);
	const absolutePath = join(root, ...path.split("/"));
	const outsideRoot =
		relative(root, absolutePath).startsWith(`..${sep}`) || relative(root, absolutePath) === "..";
	if (outsideRoot) throw new Error(`Patch path escapes workspace root: ${path}`);
	await assertNoSymlink(root, path);
	return { relativePath: path, absolutePath };
}
