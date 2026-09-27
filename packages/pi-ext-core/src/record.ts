/**
 * The one narrowing guard for a plain JSON object.
 *
 * A tool result's `details`, a settings value, a session entry and a provider
 * payload all cross an untrusted boundary as `unknown` and all need the same
 * check: an object that is neither an array nor `null`. Extensions used to write
 * this line locally, which drifted — three copies accepted arrays. Keeping one
 * guard means a reader can point at it instead of re-verifying every site.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
