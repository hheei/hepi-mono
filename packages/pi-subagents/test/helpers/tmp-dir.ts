import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Keep real SQLite transactions and process locks, without charging each test for disk fsync.
 * `/dev/shm` is available on Linux; other hosts use the normal OS temp directory.
 */
export async function createTemporaryDirectory(prefix: string): Promise<string> {
	try {
		return await mkdtemp(join("/dev/shm", prefix));
	} catch {
		return mkdtemp(join(tmpdir(), prefix));
	}
}

/** Runs `run` against a fresh temp directory that is removed afterwards. */
export async function withTempDir<T>(
	prefix: string,
	run: (directory: string) => Promise<T>,
): Promise<T> {
	const directory = await createTemporaryDirectory(prefix);
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
