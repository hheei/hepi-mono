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

type Observation = {
	state: "healthy" | "degraded";
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class AgentMemoryStatusTracker {
	readonly #observations = new Map<AgentMemoryObservedOperation, Observation>();
	#lastError: { error: string; at: number } | undefined;

	recordSuccess(operation: AgentMemoryObservedOperation): void {
		this.#observations.set(operation, { state: "healthy" });
	}

	recordFailure(operation: AgentMemoryObservedOperation, error: unknown): void {
		const at = Date.now();
		const message = errorMessage(error);
		this.#observations.set(operation, { state: "degraded" });
		this.#lastError = { error: message, at };
	}

	snapshot(
		settings: AgentMemoryConfig,
		outbox: AgentMemoryOutbox | undefined,
	): AgentMemoryStatusSnapshot {
		const health = this.#observations.get("health");
		const outboxError = outbox?.latestError() ?? null;
		const latestRuntimeError = this.#lastError;
		const latestError =
			outboxError && (!latestRuntimeError || outboxError.at > latestRuntimeError.at)
				? { error: outboxError.message, at: outboxError.at }
				: latestRuntimeError;
		const counts = outbox?.statusCounts() ?? { pending: 0, leased: 0, failed: 0 };
		return {
			enabled: settings.enabled,
			health: health?.state ?? "unknown",
			capture: this.#state(settings.enabled && settings.capture, "capture"),
			search: this.#state(settings.enabled && settings.memoryTools, "search"),
			inject: this.#state(settings.enabled && settings.inject, "inject"),
			memory: this.#state(settings.enabled && settings.memoryTools, "memory"),
			outbox: counts,
			lastError: latestError?.error ?? null,
			lastErrorAt: latestError?.at ?? null,
		};
	}

	#state(enabled: boolean, operation: AgentMemoryObservedOperation): AgentMemoryObservedState {
		if (!enabled) return "disabled";
		return this.#observations.get(operation)?.state ?? "idle";
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
