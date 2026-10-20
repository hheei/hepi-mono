import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";

export const PYTHON_EVAL_FACTS_TYPE = "pi-python-eval:execution";

type EvalExecutionFact =
	| {
			readonly phase: "start";
			readonly cellId: string;
			readonly generation: string;
			readonly startedAt: number;
	  }
	| {
			readonly phase: "end";
			readonly cellId: string;
			readonly generation: string;
			readonly outcome: "completed" | "failed" | "cancelled" | "timed_out";
			readonly endedAt: number;
			readonly names?: number;
			readonly diagnostic?: string;
	  };

export interface EvalExecutionFactsStore {
	readonly previous: () => {
		readonly generation: string | undefined;
		readonly recovery: string | undefined;
	};
	readonly start: (cellId: string, generation: string) => void;
	readonly end: (fact: {
		readonly cellId: string;
		readonly generation: string;
		readonly outcome: Extract<EvalExecutionFact, { readonly phase: "end" }>["outcome"];
		readonly names: number | undefined;
		readonly diagnostic?: string;
	}) => void;
}

export function createEvalExecutionFacts(
	pi: Pick<ExtensionAPI, "appendEntry">,
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">,
): EvalExecutionFactsStore {
	let generation: string | undefined;
	let recovery: string | undefined;
	const openCells = new Set<string>();
	try {
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== PYTHON_EVAL_FACTS_TYPE) continue;
			const fact = readFact(entry.data);
			if (fact === undefined) continue;
			generation = fact.generation;
			if (fact.phase === "start") openCells.add(fact.cellId);
			else openCells.delete(fact.cellId);
		}
		if (openCells.size > 0)
			recovery = "previous python_eval cell has unknown outcome; side effects may have occurred";
	} catch {
		generation = undefined;
		recovery = undefined;
	}
	const append = (fact: EvalExecutionFact): void => {
		try {
			pi.appendEntry(PYTHON_EVAL_FACTS_TYPE, fact);
		} catch {}
	};
	return {
		previous: () => ({ generation, recovery }),
		start(cellId, currentGeneration): void {
			generation = currentGeneration;
			append({ phase: "start", cellId, generation: currentGeneration, startedAt: Date.now() });
		},
		end(fact): void {
			generation = fact.generation;
			append({
				phase: "end",
				cellId: fact.cellId,
				generation: fact.generation,
				outcome: fact.outcome,
				endedAt: Date.now(),
				...(fact.names === undefined ? {} : { names: fact.names }),
				...(fact.diagnostic === undefined ? {} : { diagnostic: fact.diagnostic }),
			});
		},
	};
}

function readFact(value: unknown): EvalExecutionFact | undefined {
	if (
		!isRecord(value) ||
		typeof value.phase !== "string" ||
		typeof value.cellId !== "string" ||
		typeof value.generation !== "string"
	)
		return undefined;
	if (value.phase === "start" && typeof value.startedAt === "number")
		return {
			phase: "start",
			cellId: value.cellId,
			generation: value.generation,
			startedAt: value.startedAt,
		};
	if (
		value.phase === "end" &&
		(value.outcome === "completed" ||
			value.outcome === "failed" ||
			value.outcome === "cancelled" ||
			value.outcome === "timed_out") &&
		typeof value.endedAt === "number"
	) {
		return {
			phase: "end",
			cellId: value.cellId,
			generation: value.generation,
			outcome: value.outcome,
			endedAt: value.endedAt,
			...(typeof value.names === "number" ? { names: value.names } : {}),
			...(typeof value.diagnostic === "string" ? { diagnostic: value.diagnostic } : {}),
		};
	}
	return undefined;
}
