import {
	type ContextEvent,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlot } from "#core/hooks/lkg-slot";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { RecallLedger } from "../../src/agentmemory/recall";
import {
	clearContextHandlerSession,
	collectMessageEntryIdsByRef,
	__test as contextInternals,
	registerPiContextHandler,
} from "../../src/context-handler";
import { handlePiSessionBeforeCompact, handlePiSessionCompact } from "../../src/index";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	assistantMessage as makeAssistantMessage,
} from "../test-utils.test";

function userMessage(content: string, timestamp: number) {
	return { role: "user" as const, content, timestamp };
}

function assistantMessage(content: string, timestamp: number) {
	const message = makeAssistantMessage(content, timestamp);
	if (message.role !== "assistant") throw new Error("expected assistant fixture");
	return message;
}

function deferred() {
	let resolve: () => void = () => {
		throw new Error("resolver not initialized");
	};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
	const db = createTestDb();
	const manager = SessionManager.inMemory(process.cwd());
	const sessionId = manager.getSessionId();
	const ledger = new RecallLedger(db);
	const fake = createFakePi();
	const search = vi.fn(async () => [
		{ id: "durable", kind: "memory", content: "Durable recall evidence", digest: "digest" },
	]);
	let beforePrepare = async () => {};
	let failAfterPrepare = false;
	registerPiContextHandler(fake.pi as never, {
		db,
		agentMemoryProjection: {
			prepareRecall: async (request) => {
				await beforePrepare();
				return ledger.prepare({ ...request, epoch: ledger.preUpgradeEpoch(request), search });
			},
			commitRecall: (draft) => ledger.commit(draft),
		},
		maybeAutoEmbedSession: () => {
			if (failAfterPrepare) throw new Error("forced post-projection failure");
		},
	});
	const handler = fake.handlers.get("context") as (
		event: ContextEvent,
		ctx: ExtensionContext,
	) => Promise<{ messages: ContextEvent["messages"] } | undefined>;
	const ctx = {
		...fakeContext(sessionId),
		sessionManager: manager,
		getSystemPrompt: () => "stable prompt",
	} as unknown as ExtensionContext;
	const invoke = () =>
		handler(
			{ type: "context", messages: structuredClone(manager.buildSessionContext().messages) },
			ctx,
		);
	cleanups.push(() => {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	});
	const heads = () =>
		db
			.prepare(
				"SELECT branch_id, state_id, body_json FROM mctx_context_projection_heads ORDER BY branch_id",
			)
			.all();
	return {
		db,
		manager,
		sessionId,
		ctx,
		invoke,
		heads,
		search,
		pause: (fn: () => Promise<void>) => {
			beforePrepare = fn;
		},
		fail: () => {
			failAfterPrepare = true;
		},
	};
}

describe("AgentMemory Pi lifecycle projection", () => {
	it("does not resolve future entries through an earlier cached branch snapshot", () => {
		const f = fixture();
		f.manager.appendMessage(userMessage("past", 1));
		const oldBranch = contextInternals.readPiBranchEntriesForContext(f.ctx, f.sessionId);
		const future = userMessage("future", 2);
		f.manager.appendMessage(future);
		contextInternals.readPiBranchEntriesForContext(f.ctx, f.sessionId);
		expect(
			collectMessageEntryIdsByRef(
				f.ctx,
				[structuredClone(future)],
				f.sessionId,
				oldBranch ?? undefined,
			),
		).toEqual([undefined]);
	});

	it("rebuilds recall after native SessionManager compaction with a synthetic summary and kept tail", async () => {
		const f = fixture();
		f.manager.appendMessage(userMessage("old question", 1));
		f.manager.appendMessage(assistantMessage("old answer", 2));
		const kept = f.manager.appendMessage(userMessage("kept question", 3));
		f.manager.appendMessage(assistantMessage("kept answer", 4));
		const first = await f.invoke();
		expect(JSON.stringify(first)).toContain("Durable recall evidence");
		const oldHeads = f.heads();
		await handlePiSessionBeforeCompact({ db: f.db, compactionOff: false, ctx: f.ctx });
		f.manager.appendCompaction("native summary", kept, 100);
		handlePiSessionCompact({ db: f.db, ctx: f.ctx });
		const compacted = await f.invoke();
		expect(JSON.stringify(compacted)).toContain("native summary");
		expect(JSON.stringify(compacted)).toContain("Durable recall evidence");
		expect(JSON.stringify(compacted)).not.toContain("old question");
		expect(f.heads()).not.toEqual(oldHeads);
		expect(f.db.prepare("SELECT user_entry_id FROM mctx_recall_events").all()).toEqual(
			expect.arrayContaining([{ user_entry_id: kept }]),
		);
	});

	it("restores the persisted branch head after clearing all in-memory branch state", async () => {
		const f = fixture();
		const root = f.manager.appendMessage(userMessage("root", 1));
		const a = f.manager.appendMessage(userMessage("branch a", 2));
		await f.invoke();
		f.manager.branch(root);
		const b = f.manager.appendMessage(userMessage("branch b", 3));
		await f.invoke();
		const before = f.heads();
		clearContextHandlerSession(f.sessionId);
		await f.invoke();
		expect(f.heads()).toEqual(before);
		f.manager.branch(a);
		clearContextHandlerSession(f.sessionId);
		await f.invoke();
		expect(f.heads()).toEqual(before);
		f.manager.branch(b);
	});

	it("serves captured LKG on a late transform error without publishing partial recall", async () => {
		const f = fixture();
		f.manager.appendMessage(userMessage("question", 1));
		f.manager.appendMessage(assistantMessage("answer", 2));
		const first = await f.invoke();
		expect(first).toBeDefined();
		expect(getSlot(f.sessionId)).toBeDefined();
		const before = f.heads();
		f.fail();
		const replay = await f.invoke();
		expect(replay).toBeDefined();
		expect(JSON.stringify(replay)).toContain("Durable recall evidence");
		expect(f.heads()).toEqual(before);
	});

	it("rejects deferred recall after tree navigation rather than replaying the old branch LKG", async () => {
		const f = fixture();
		const root = f.manager.appendMessage(userMessage("root", 1));
		f.manager.appendMessage(userMessage("branch a", 2));
		await f.invoke();
		const before = f.heads();
		const entered = deferred();
		const release = deferred();
		f.pause(async () => {
			entered.resolve();
			await release.promise;
		});
		const pending = f.invoke();
		await entered.promise;
		f.manager.branch(root);
		f.manager.appendMessage(userMessage("branch b", 3));
		release.resolve();
		await expect(pending).rejects.toThrow();
		expect(f.heads()).toEqual(before);
	});
});
