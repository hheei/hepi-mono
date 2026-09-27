import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expands a leading `~` against the home directory; paths without one are returned unchanged.
 *
 * User-facing configuration (settings files, agent definitions, resource selections) writes
 * paths as `~/...`, and each package used to expand that by hand. The copies drifted: one
 * handled only `~/x` and left a bare `~` to be resolved as a literal directory name.
 * Callers that need an absolute path resolve the result against their own base directory.
 */
export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}
