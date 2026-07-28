import { createHash } from "node:crypto";
import { resolve } from "node:path";

function stableProjectKey(cwd: string): string {
	return createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12);
}

export function getProjectDatabasePaths(root: string, cwd: string) {
	const dbDir = resolve(root, stableProjectKey(cwd));
	return {
		dbDir,
		frecencyDbPath: resolve(dbDir, "frecency.db"),
		historyDbPath: resolve(dbDir, "history.db"),
	};
}
