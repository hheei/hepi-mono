import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { ensureContextProjectionSchema } from "../../src/agentmemory/context-projection";
import { RecallLedger, type RecallSource } from "../../src/agentmemory/recall";
import {
	createRecallPresenter,
	readRecentRecallPreview,
} from "../../src/agentmemory/recall-presenter";

async function admit(db: Database, contents: readonly string[], now = 10): Promise<void> {
	const ledger = new RecallLedger(db);
	const epoch = ledger.declarePreUpgradeEpoch({ sessionId: "session-1", now });
	const prepared = await ledger.prepare({
		sessionId: "session-1",
		userEntryId: `user-${now}`,
		query: "query",
		epoch,
		search: async (): Promise<readonly RecallSource[]> =>
			contents.map((content, index) => ({
				id: `memory-${now}-${index}`,
				kind: "memory",
				content,
				digest: `digest-${now}-${index}`,
			})),
		now,
	});
	if (prepared.kind !== "prepared") throw new Error("expected prepared recall");
	ledger.commit(prepared.draft);
	db.prepare(
		"INSERT INTO mctx_context_projection_heads (session_id, branch_id, state_id, epoch_id, generation, contract_digest, body_digest, body_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"session-1",
		"root",
		`state-${now}`,
		epoch.id,
		epoch.generation,
		"contract",
		"body",
		"[]",
		now,
	);
}

function createHarness(options: { throwOnMount?: boolean } = {}) {
	let throwOnMount = options.throwOnMount === true;
	let component: Component | undefined;
	const setWidget = vi.fn((_id: string, factory: unknown) => {
		if (factory === undefined) return;
		if (throwOnMount) throw new Error("widget unavailable");
		component = (
			factory as (
				tui: { requestRender(force?: boolean): void },
				theme: { fg(name: string, text: string): string },
			) => Component
		)({ requestRender: () => undefined }, { fg: (_name, text) => text });
	});
	return {
		pi: {} as never,
		context: {
			mode: "tui",
			ui: { setWidget },
			sessionManager: { getSessionId: () => "session-1" },
		} as never,
		setWidget,
		component: () => component,
		allowMount: () => {
			throwOnMount = false;
		},
	};
}

describe("AgentMemory recall presenter", () => {
	let db: Database;
	beforeEach(() => {
		db = new Database(":memory:");
		ensureContextProjectionSchema(db);
	});
	afterEach(() => {
		vi.useRealTimers();
		closeQuietly(db);
	});

	it("claims, renders, and receipts each event once", async () => {
		await admit(db, [`line one\n\u001b[31mline two ${"界".repeat(200)}`, "additional source"]);
		const harness = createHarness();
		const presenter = createRecallPresenter(
			harness.pi,
			harness.context,
			new AbortController().signal,
			db,
		);
		presenter?.present("session-1");
		presenter?.present("session-1");

		expect(harness.setWidget).toHaveBeenCalledTimes(1);
		expect(
			db.prepare("SELECT count(*) AS count FROM mctx_recall_presentation_receipts").get(),
		).toEqual({
			count: 0,
		});
		const rendered = harness.component()?.render(80).join("\n") ?? "";
		expect(rendered.match(/line one/g)).toHaveLength(1);
		expect(rendered).toContain("(+1)");
		expect(rendered).not.toContain("additional source");
		for (const width of [0, 1, 8, 24, 100]) {
			expect(
				harness
					.component()
					?.render(width)
					.every((line) => visibleWidth(line) <= width),
			).toBe(true);
		}
		const preview = readRecentRecallPreview(db, "session-1");
		expect(preview).toHaveLength(2);
		expect(preview[0]).not.toContain("\n");
		expect(preview[0]).not.toContain("\u001b");
		expect(preview[0]?.length).toBeLessThanOrEqual(249);

		presenter?.present("session-1");
		expect(
			db.prepare("SELECT count(*) AS count FROM mctx_recall_presentation_receipts").get(),
		).toEqual({
			count: 1,
		});
	});

	it("retries an unpresented claim after a failed mount lease expires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		await admit(db, ["retry this recall"]);
		const harness = createHarness({ throwOnMount: true });
		const presenter = createRecallPresenter(
			harness.pi,
			harness.context,
			new AbortController().signal,
			db,
		);
		presenter?.present("session-1");
		expect(
			db.prepare("SELECT count(*) AS count FROM mctx_recall_presentation_receipts").get(),
		).toEqual({
			count: 0,
		});
		harness.allowMount();
		vi.setSystemTime(31_001);
		presenter?.present("session-1");
		expect(harness.component()?.render(80).join("\n")).toContain("retry this recall");
		expect(
			db.prepare("SELECT count(*) AS count FROM mctx_recall_presentation_receipts").get(),
		).toEqual({
			count: 1,
		});
	});

	it("keeps the presenter out of RPC mode", () => {
		const setWidget = vi.fn();
		expect(
			createRecallPresenter(
				{} as never,
				{ mode: "rpc", ui: { setWidget } } as never,
				new AbortController().signal,
				db,
			),
		).toBeUndefined();
		expect(setWidget).not.toHaveBeenCalled();
	});

	it("keeps status preview available when recall storage is unavailable", () => {
		closeQuietly(db);
		expect(readRecentRecallPreview(db, "session-1")).toEqual([]);
	});
});
