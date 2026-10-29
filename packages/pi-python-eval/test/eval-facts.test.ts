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
		expect(restored.previous()).toEqual({
			readable: true,
			generation: "generation-1",
			recovery: undefined,
		});
		expect(first.entries).toHaveLength(2);
		expect(first.entries[0]?.customType).toBe(PYTHON_EVAL_FACTS_TYPE);
	});

	test("reports an open cell as unknown after runtime recreation", () => {
		const first = fixture();
		const facts = createEvalExecutionFacts(first.pi, first.sessionManager);
		facts.start("cell-1", "generation-1");

		const restored = createEvalExecutionFacts(first.pi, first.sessionManager);
		expect(restored.previous()).toEqual({
			readable: true,
			generation: "generation-1",
			recovery: "previous python_eval cell has unknown outcome; side effects may have occurred",
		});
	});

	test("a write that failed says so instead of reporting success", () => {
		const pi = {
			appendEntry: (): never => {
				throw new Error("ledger unavailable");
			},
		};
		const facts = createEvalExecutionFacts(pi, { getBranch: () => [] });

		// The store reports the failure; what it costs is decided by the caller that knows the cell.
		expect(facts.start("cell-1", "generation-1")).toEqual({
			saved: false,
			reason: "ledger unavailable",
		});
		expect(
			facts.end({ cellId: "cell-1", generation: "generation-1", outcome: "failed", names: 0 }),
		).toEqual({ saved: false, reason: "ledger unavailable" });
	});

	test("reports unreadable history instead of claiming a clean start", () => {
		const facts = createEvalExecutionFacts(
			{ appendEntry: () => undefined },
			{
				getBranch: () => {
					throw new Error("branch unavailable");
				},
			},
		);
		expect(facts.previous()).toEqual({ readable: false, reason: "branch unavailable" });
	});

	test("a start fact that cannot be saved stops the cell before it runs", async () => {
		const facts = createEvalExecutionFacts(
			{
				appendEntry: (): never => {
					throw new Error("ledger unavailable");
				},
			},
			{ getBranch: () => [] },
		);
		const host = new EvalKernelHost(process.cwd(), { facts });
		try {
			await expect(host.runWithHooks("open('/tmp/never', 'w')", hooks())).rejects.toThrow(
				/python_eval did not run: the recovery record could not be saved/,
			);
		} finally {
			host.dispose();
		}
	});

	test("an end fact that cannot be saved is reported without changing the cell", async () => {
		const facts = createEvalExecutionFacts(
			{
				appendEntry: (_type: string, data: unknown): void => {
					if ((data as { phase?: string }).phase === "end") throw new Error("ledger unavailable");
				},
			},
			{ getBranch: () => [] },
		);
		const host = new EvalKernelHost(process.cwd(), { facts });
		const notes: string[] = [];
		try {
			const result = await host.runWithHooks("1 + 1", {
				...hooks(),
				onDiagnostic: (text: string) => notes.push(text),
			});
			// The cell did what it did; only the record of it is missing.
			expect(result.value).toBe(2);
			expect(notes).toEqual(["recovery record not saved: ledger unavailable"]);
		} finally {
			host.dispose();
		}
	});

	test("tells the next cell when earlier history could not be read", async () => {
		const facts = createEvalExecutionFacts(
			{ appendEntry: () => undefined },
			{
				getBranch: () => {
					throw new Error("branch unavailable");
				},
			},
		);
		const host = new EvalKernelHost(process.cwd(), { facts });
		try {
			const result = await host.runWithHooks("1", hooks());
			expect(result.recovered).toContain("earlier python_eval history could not be read");
			expect(result.recovered).toContain("branch unavailable");
		} finally {
			host.dispose();
		}
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
