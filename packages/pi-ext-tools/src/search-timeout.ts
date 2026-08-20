/** Shared wall-clock budget for find/grep. 0 means unlimited in the FFF engine. */
export const SEARCH_TIMEOUT_MS = 20_000;

export const GREP_TIMEOUT_RECOVERY =
	"Search timed out. Narrow the scope: set path to a subdirectory or file, add a glob, or use a more specific pattern.";

export const FIND_TIMEOUT_RECOVERY =
	"Search timed out. Narrow the scope: set path to a directory prefix or glob, add exclude, or use more specific terms.";
