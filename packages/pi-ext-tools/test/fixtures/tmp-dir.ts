import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/**
 * Temp-directory factory for the importing test file.
 *
 * The returned function creates a directory under `tmpdir()` with the given
 * prefix and registers it for removal when that test file finishes, so a file
 * only writes `const temporaryDirectory = temporaryDirectories("name-")` instead
 * of its own list, cleanup hook and mkdtemp call. The prefix is per file so a
 * leaked directory is traceable to the test that made it.
 */
export function temporaryDirectories(prefix: string): () => Promise<string> {
	const paths: string[] = [];
	afterEach(async (): Promise<void> => {
		await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});
	return async (): Promise<string> => {
		const path = await mkdtemp(join(tmpdir(), prefix));
		paths.push(path);
		return path;
	};
}
