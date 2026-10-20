import { describe, expect, test } from "vitest";
import { createEvalExecutionFacts, PYTHON_EVAL_FACTS_TYPE } from "../src/facts.js";
import { EvalKernelHost } from "../src/kernel/host.js";

type Entry = { readonly type: "custom"; readonly customType: string; readonly data: unknown };

function fixture() {
	const entries: Entry[] = [];
	const pi = {
		appendEntry(type: string, data: unknown): void {
			entries.push({ type: "custom", customType: type, data });
		},
	};
	const sessionManager = { getBranch: () => entries as never };
	return { entries, pi, sessionManager };
}

function hooks() {
	return {
		cwd: process.cwd(),
		onText: (): void => undefined,
		onDisplay: (): void => undefined,
		onBackground: (): void => undefined,
		callTool: async (): Promise<never> => {
			throw new Error("unexpected nested call");
		},
	};
}

describe("python eval execution facts", () => {
	test("restores completed generation from the active branch", () => {
		const first = fixture();
		const facts = createEvalExecutionFacts(first.pi, first.sessionManager);
		facts.start("cell-1", "generation-1");
		facts.end({ cellId: "cell-1", generation: "generation-1", outcome: "completed", names: 2 });

		const restored = createEvalExecutionFacts(first.pi, first.sessionManager);
		expect(restored.previous()).toEqual({ generation: "generation-1", recovery: undefined });
		expect(first.entries).toHaveLength(2);
		expect(first.entries[0]?.customType).toBe(PYTHON_EVAL_FACTS_TYPE);
	});

	test("reports an open cell as unknown after runtime recreation", () => {
		const first = fixture();
		const facts = createEvalExecutionFacts(first.pi, first.sessionManager);
		facts.start("cell-1", "generation-1");

		const restored = createEvalExecutionFacts(first.pi, first.sessionManager);
		expect(restored.previous()).toEqual({
			generation: "generation-1",
			recovery: "previous python_eval cell has unknown outcome; side effects may have occurred",
		});
	});

	test("does not make append failures fail the cell path", () => {
		const pi = {
			appendEntry: (): never => {
				throw new Error("ledger unavailable");
			},
		};
		const facts = createEvalExecutionFacts(pi, { getBranch: () => [] });

		expect(() => facts.start("cell-1", "generation-1")).not.toThrow();
		expect(() =>
			facts.end({ cellId: "cell-1", generation: "generation-1", outcome: "failed", names: 0 }),
		).not.toThrow();
	});

	test("marks first cell after runtime recreation as restarted", async () => {
		const first = fixture();
		const firstFacts = createEvalExecutionFacts(first.pi, first.sessionManager);
		const firstHost = new EvalKernelHost(process.cwd(), { facts: firstFacts });
		await firstHost.runWithHooks("kept = 1", hooks());
		firstHost.dispose();

		const restoredFacts = createEvalExecutionFacts(first.pi, first.sessionManager);
		const restoredHost = new EvalKernelHost(process.cwd(), { facts: restoredFacts });
		try {
			const result = await restoredHost.runWithHooks("names()", hooks());
			expect(result.restarted).toBe(true);
			expect(result.recovered).toBeUndefined();
			expect(result.state?.names).toBe(0);
		} finally {
			restoredHost.dispose();
		}
	});
});
