/** Per-session user pause for embedding drain (in-memory only). */
export const embedPauseBySession = new Set<string>();

/** AbortController for the active embed drain per session. */
export const embedRunStateBySession = new Map<string, AbortController>();

/** One auto-drain attempt per session per process lifetime. */
export const autoEmbedAttemptedBySession = new Set<string>();

export type EmbedDrainUiStatus = "idle" | "running" | "paused" | "stopped";
