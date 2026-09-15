import type { AgentMemoryConfig } from "#core/config/schema/magic-context";
import type { AgentMemoryOutbox } from "./outbox";

export type AgentMemoryObservedState = "disabled" | "idle" | "healthy" | "degraded";
export type AgentMemoryObservedOperation = "health" | "capture" | "search" | "inject" | "memory";

export type AgentMemoryStatusSnapshot = {
	readonly enabled: boolean;
	readonly health: "unknown" | "healthy" | "degraded";
	readonly capture: AgentMemoryObservedState;
	readonly search: AgentMemoryObservedState;
	readonly inject: AgentMemoryObservedState;
	readonly memory: AgentMemoryObservedState;
	readonly outbox: {
		readonly pending: number;
		readonly leased: number;
		readonly failed: number;
	};
	readonly lastError: string | null;
	readonly lastErrorAt: number | null;
};

export class AgentMemoryStatusTracker {
	readonly #observations = new Map<AgentMemoryObservedOperation, "healthy" | "degraded">();
	#lastError: { message: string; at: number } | undefined;

	recordSuccess(operation: AgentMemoryObservedOperation): void {
		this.#observations.set(operation, "healthy");
	}

	recordFailure(operation: AgentMemoryObservedOperation, error: unknown): void {
		const at = Date.now();
		const message = error instanceof Error ? error.message : String(error);
		this.#observations.set(operation, "degraded");
		this.#lastError = { message, at };
	}

	snapshot(
		settings: AgentMemoryConfig,
		outbox: AgentMemoryOutbox | undefined,
	): AgentMemoryStatusSnapshot {
		const outboxError = outbox?.latestError() ?? null;
		const latestError =
			outboxError && (!this.#lastError || outboxError.at > this.#lastError.at)
				? outboxError
				: this.#lastError;
		return {
			enabled: settings.enabled,
			health: this.#observations.get("health") ?? "unknown",
			capture: this.#state(settings.enabled && settings.capture, "capture"),
			search: this.#state(settings.enabled && settings.memoryTools, "search"),
			inject: this.#state(settings.enabled && settings.inject, "inject"),
			memory: this.#state(settings.enabled && settings.memoryTools, "memory"),
			outbox: outbox?.statusCounts() ?? { pending: 0, leased: 0, failed: 0 },
			lastError: latestError?.message ?? null,
			lastErrorAt: latestError?.at ?? null,
		};
	}

	#state(enabled: boolean, operation: AgentMemoryObservedOperation): AgentMemoryObservedState {
		if (!enabled) return "disabled";
		return this.#observations.get(operation) ?? "idle";
	}
}

export function formatAgentMemoryStatus(snapshot: AgentMemoryStatusSnapshot): string[] {
	if (!snapshot.enabled) return ["AgentMemory: disabled"];
	const outbox = snapshot.outbox;
	const lines = [
		`AgentMemory: health=${snapshot.health} capture=${snapshot.capture} search=${snapshot.search} inject=${snapshot.inject} memory=${snapshot.memory}`,
		`AgentMemory outbox: pending=${outbox.pending} leased=${outbox.leased} failed=${outbox.failed}`,
	];
	if (snapshot.lastError) lines.push(`AgentMemory last error: ${snapshot.lastError}`);
	return lines;
}
