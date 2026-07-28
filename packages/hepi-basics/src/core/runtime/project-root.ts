import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function resolveHepiProjectRoot(cwd: string): Promise<string> {
	const start = resolve(cwd);
	let current = start;
	for (;;) {
		if (await pathExists(resolve(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}
