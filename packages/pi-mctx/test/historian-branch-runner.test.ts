import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionLifecycleContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type MctxHistorianExecutor,
	runMctxHistorianForBranch,
} from "../src/historian-branch-runner.js";
import type { MctxCompartmentDraft, MctxHistorianLease, MctxPartition } from "../src/store.js";

const model = { api: "test", provider: "test", id: "historian" } as Model<Api>;
const partition = { projectIdentity: "project", sessionId: "session", revision: 0 } as const;

function entry(id: string, role: "user" | "assistant", content = id): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: { role, content, timestamp: 1 },
	} as SessionEntry;
}

function request(entries: readonly SessionEntry[]) {
	const lease: MctxHistorianLease = { partition, ownerToken: "owner", expiresAtMs: 60_000 };
	return {
		context: {} as ExtensionLifecycleContext,
		model,
		entries,
		partition,
		signal: new AbortController().signal,
		leaseOwnerToken: "owner",
		store: {
			acquireHistorianLease: () => lease,
			releaseHistorianLease: () => undefined,
			publishCompartment: (_partition: MctxPartition, draft: MctxCompartmentDraft) => ({
				partition: { ...partition, revision: 1 },
				compartment: { ...draft, sequence: 0, publishedRevision: 1 },
			}),
		},
	};
}

test("leaves projection-ineligible branches without a historian call", async (): Promise<void> => {
	const result = await runMctxHistorianForBranch(
		request([entry("user", "user"), entry("assistant", "assistant")]),
		async () => {
			throw new Error("must not execute");
		},
	);
	expect(result).toEqual({ kind: "ineligible", reason: "protected-tail" });
});

test("projects older branch turns into the lease-guarded historian", async (): Promise<void> => {
	let receivedSourceText = "";
	const executor: MctxHistorianExecutor = async (_context, completion) => {
		receivedSourceText = completion.sourceText;
		return {
			kind: "completed",
			output: JSON.stringify({
				tier: "m0",
				sourceStartEntryId: "user-1",
				sourceEndEntryId: "assistant-1",
				renderedPayload: "summary",
			}),
		};
	};
	const result = await runMctxHistorianForBranch(
		request([
			entry("user-1", "user", "old request"),
			entry("assistant-1", "assistant", "old response"),
			entry("user-2", "user", "new request"),
			entry("assistant-2", "assistant", "new response"),
		]),
		executor,
	);
	expect(result).toMatchObject({ kind: "published", repaired: false });
	expect(receivedSourceText).toContain("old request");
	expect(receivedSourceText).not.toContain("new request");
});
