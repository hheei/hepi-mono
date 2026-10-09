import type { PublicSubagent } from "../../src/domain.js";

/** A running child record with every field the widget and status line read. */
export function child(overrides: Partial<PublicSubagent> = {}): PublicSubagent {
	return {
		id: "sa_aaaaaaaaaaaa",
		agent: "worker",
		state: "running",
		presentation: "background",
		cwd: "/tmp/work",
		sessionId: "session-1",
		freshness: "live",
		model: { provider: "test", id: "model", source: "parent" },
		thinking: { level: "off", source: "parent" },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}
