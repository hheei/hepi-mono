import { createHash } from "node:crypto";
import { dropSlot } from "#core/hooks/lkg-slot";
import type { Database } from "#core/shared/sqlite";
import { stableStringify } from "#core/shared/stable-json";
import {
	type RecallAdmission,
	type RecallDraft,
	type RecallEvent,
	RecallLedger,
	type RecallPreparation,
} from "./recall";

const PROJECTION_HEAD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mctx_context_projection_heads (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  state_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  contract_digest TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, branch_id)
);
`;

export type ProjectionClassification = "unchanged" | "append" | "transition";

export type ProjectionContract = {
	readonly model?: unknown;
	readonly systemPrompt?: string | undefined;
	readonly tools?: unknown;
};

export type ProjectionRecallRequest = {
	readonly sessionId: string;
	readonly branchId: string;
	readonly generation: number;
	readonly userEntryId: string;
	readonly query: string;
	readonly signal?: AbortSignal | undefined;
};

export type ProjectionRecallFailure = {
	readonly stage: "prepare" | "commit";
	readonly error: unknown;
};

class RecallAdmissionPublishError extends Error {
	readonly cause: unknown;

	constructor(cause: unknown) {
		super("prepared recall was not admitted during projection publish");
		this.name = "RecallAdmissionPublishError";
		this.cause = cause;
	}
}

class StaleContextProjectionError extends Error {
	constructor() {
		super("context projection became stale before publish");
		this.name = "StaleContextProjectionError";
	}
}
export type PreparedContextProjection<T> = {
	readonly classification: ProjectionClassification;
	readonly epochId: string;
	readonly generation: number;
	readonly messages: readonly T[];
	readonly recallFailure?: ProjectionRecallFailure | undefined;
	publish(): {
		readonly messages: readonly T[];
		readonly recallFailure?: ProjectionRecallFailure | undefined;
	};
};

type ProjectionHead = {
	readonly stateId: string;
	readonly epochId: string;
	readonly generation: number;
	readonly contractDigest: string;
	readonly bodyJson: string;
};

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function epochId(sessionId: string, branchId: string, generation: number): string {
	return `epoch_${sha256(`${sessionId}\0${branchId}\0${generation}`).slice(0, 32)}`;
}

function classifyProjection(
	head: ProjectionHead | undefined,
	contractDigest: string,
	bodyJson: string,
): ProjectionClassification {
	if (!head || head.contractDigest !== contractDigest) return "transition";
	if (head.bodyJson === bodyJson) return "unchanged";
	const prefix = head.bodyJson.slice(0, -1);
	return bodyJson.startsWith(prefix) && bodyJson.charCodeAt(prefix.length) === 44
		? "append"
		: "transition";
}

function readHead(db: Database, sessionId: string, branchId: string): ProjectionHead | undefined {
	return db
		.prepare(
			`SELECT state_id AS stateId, epoch_id AS epochId, generation,
			 contract_digest AS contractDigest, body_json AS bodyJson
			 FROM mctx_context_projection_heads
			 WHERE session_id = ? AND branch_id = ?`,
		)
		.get(sessionId, branchId) as ProjectionHead | undefined;
}

function spliceRecallEvents<T>(
	messages: readonly T[],
	events: readonly RecallEvent[],
	resolveEntryId: (message: T, index: number) => string | undefined,
	createRecallMessage: (content: string, event: RecallEvent) => T,
): T[] {
	const byAnchor = new Map(events.map((event) => [event.userEntryId, event]));
	const result: T[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message === undefined) continue;
		result.push(message);
		const event = byAnchor.get(resolveEntryId(message, index) ?? "");
		if (!event) continue;
		const sources = event.sources
			.map((source) => `- [${source.kind}:${source.id}] ${source.content.trim()}`)
			.join("\n");
		result.push(
			createRecallMessage(
				`<system-reminder>\nAgentMemory recall for this user turn:\n${sources}\n</system-reminder>`,
				event,
			),
		);
	}
	return result;
}

export function ensureContextProjectionSchema(db: Database): void {
	const columns = db.prepare("PRAGMA table_info(mctx_context_projection_heads)").all() as Array<{
		name: string;
	}>;
	const legacy =
		columns.some((column) => column.name === "state_id") &&
		!columns.some((column) => column.name === "body_json");
	if (legacy) {
		db.transaction(() => {
			db.exec(
				"ALTER TABLE mctx_context_projection_heads RENAME TO mctx_context_projection_heads_legacy",
			);
			db.exec(PROJECTION_HEAD_SCHEMA_SQL);
			db.exec(`INSERT INTO mctx_context_projection_heads
				(session_id, branch_id, state_id, epoch_id, generation, contract_digest, body_digest, body_json, updated_at)
				SELECT head.session_id, head.branch_id, head.state_id, head.epoch_id, head.generation,
				       state.contract_digest, state.body_digest, state.body_json, head.updated_at
				FROM mctx_context_projection_heads_legacy AS head
				JOIN mctx_context_projection_states AS state ON state.id = head.state_id`);
			db.exec("DROP TABLE mctx_context_projection_heads_legacy");
			db.exec("DROP TABLE mctx_context_projection_states");
		})();
	} else {
		db.exec(PROJECTION_HEAD_SCHEMA_SQL);
	}
}

export async function prepareContextProjection<T>(input: {
	readonly db: Database;
	readonly sessionId: string;
	readonly branchId?: string | undefined;
	readonly branchTipId?: string | undefined;
	readonly messages: readonly T[];
	readonly contract: ProjectionContract;
	readonly resolveEntryId: (message: T, index: number) => string | undefined;
	readonly createRecallMessage: (content: string, event: RecallEvent) => T;
	readonly currentUserEntryId?: string | undefined;
	readonly currentQuery?: string | undefined;
	readonly prepareRecall?:
		| ((request: ProjectionRecallRequest) => Promise<RecallPreparation>)
		| undefined;
	readonly commitRecall?: ((draft: RecallDraft) => RecallAdmission) | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly isCurrent?: (() => boolean) | undefined;
	readonly now?: number | undefined;
}): Promise<PreparedContextProjection<T>> {
	ensureContextProjectionSchema(input.db);
	const recallLedger = new RecallLedger(input.db);
	const sessionId = input.sessionId.trim();
	const branchId = (input.branchId ?? "root").trim();
	const head = readHead(input.db, sessionId, branchId);
	const contractDigest = sha256(stableStringify(input.contract));
	const priorEvents = head ? recallLedger.admittedEvents(sessionId, head.epochId) : [];
	const visibleEntryIds = new Set(
		input.messages.flatMap((message, index) => {
			const entryId = input.resolveEntryId(message, index);
			return entryId === undefined ? [] : [entryId];
		}),
	);
	const replayed = spliceRecallEvents(
		input.messages,
		priorEvents,
		input.resolveEntryId,
		input.createRecallMessage,
	);
	const replayedJson = JSON.stringify(replayed);
	const initialClassification = classifyProjection(head, contractDigest, replayedJson);
	let generation: number = head?.generation ?? 0;
	if (head === undefined) {
		const previous = input.db
			.prepare(
				"SELECT MAX(generation) AS generation FROM mctx_projection_epochs WHERE session_id = ? AND branch_id = ?",
			)
			.get(sessionId, branchId) as { generation: number | null };
		generation = (previous.generation ?? -1) + 1;
	} else if (initialClassification === "transition") {
		generation += 1;
	}
	let nextEpochId = epochId(sessionId, branchId, generation);
	const rebaseDrafts = (drafts: readonly RecallDraft[]): RecallDraft[] => {
		const epoch = { id: nextEpochId, sessionId, branchId, generation };
		return [
			...priorEvents
				.filter((event) => visibleEntryIds.has(event.userEntryId))
				.map((event) => ({
					epoch,
					event,
					reused: false,
					dependencies: [],
					now: input.now ?? Date.now(),
				})),
			...drafts,
		].map((draft) => recallLedger.rebase(draft, epoch));
	};

	let events = nextEpochId === head?.epochId ? priorEvents : [];
	let recallDrafts: RecallDraft[] = [];
	if (nextEpochId !== head?.epochId) {
		recallDrafts = rebaseDrafts([]);
		events = recallDrafts.map((draft) => draft.event);
	}
	let recallFailure: ProjectionRecallFailure | undefined;
	if (
		input.prepareRecall &&
		input.currentUserEntryId &&
		input.currentQuery?.trim() &&
		visibleEntryIds.has(input.currentUserEntryId)
	) {
		try {
			const preparation = await input.prepareRecall({
				sessionId,
				branchId,
				generation,
				userEntryId: input.currentUserEntryId,
				query: input.currentQuery,
				...(input.signal ? { signal: input.signal } : {}),
			});
			if (preparation.kind === "prepared") {
				const draft = preparation.draft;
				if (!events.some((event) => event.id === draft.event.id)) {
					recallDrafts.push(draft);
					events.push(draft.event);
				}
			}
		} catch (error) {
			recallFailure = { stage: "prepare", error };
		}
	}

	let messages = spliceRecallEvents(
		input.messages,
		events,
		input.resolveEntryId,
		input.createRecallMessage,
	);
	let bodyJson = JSON.stringify(messages);
	let classification = classifyProjection(head, contractDigest, bodyJson);
	if (head && classification === "transition" && generation === head.generation) {
		generation += 1;
		nextEpochId = epochId(sessionId, branchId, generation);
		recallDrafts = rebaseDrafts(recallDrafts);
		events = recallDrafts.map((draft) => draft.event);
		messages = spliceRecallEvents(
			input.messages,
			events,
			input.resolveEntryId,
			input.createRecallMessage,
		);
		bodyJson = JSON.stringify(messages);
		classification = classifyProjection(head, contractDigest, bodyJson);
	}
	const fallbackEvents = events.filter(
		(event) => !recallDrafts.some((draft) => draft.event.id === event.id),
	);
	const fallbackMessages = spliceRecallEvents(
		input.messages,
		fallbackEvents,
		input.resolveEntryId,
		input.createRecallMessage,
	);
	const projectionState = (body: string) => {
		const bodyDigest = sha256(body);
		return {
			bodyDigest,
			stateId: `projection_${sha256(
				`${sessionId}\0${branchId}\0${generation}\0${contractDigest}\0${bodyDigest}`,
			).slice(0, 32)}`,
		};
	};
	const projectedState = projectionState(bodyJson);
	const fallbackBodyJson = JSON.stringify(fallbackMessages);
	const fallbackState = projectionState(fallbackBodyJson);
	let published = false;
	return {
		classification,
		epochId: nextEpochId,
		generation,
		messages,
		...(recallFailure ? { recallFailure } : {}),
		publish() {
			if (published) return { messages };
			const now = input.now ?? Date.now();
			const writeHead = (state: { stateId: string; bodyDigest: string }, body: string): void => {
				input.db
					.prepare(
						`INSERT INTO mctx_context_projection_heads
						 (session_id, branch_id, state_id, epoch_id, generation, contract_digest, body_digest, body_json, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(session_id, branch_id) DO UPDATE SET
						 state_id = excluded.state_id, epoch_id = excluded.epoch_id,
						 generation = excluded.generation, contract_digest = excluded.contract_digest,
						 body_digest = excluded.body_digest, body_json = excluded.body_json,
						 updated_at = excluded.updated_at`,
					)
					.run(
						sessionId,
						branchId,
						state.stateId,
						nextEpochId,
						generation,
						contractDigest,
						state.bodyDigest,
						body,
						now,
					);
			};
			const assertUnchangedHead = (): void => {
				const currentHead = readHead(input.db, sessionId, branchId);
				if (
					currentHead?.stateId !== projectedState.stateId &&
					currentHead?.stateId !== head?.stateId
				) {
					throw new Error("context projection head changed before publish");
				}
			};
			try {
				input.db.transaction(() => {
					assertUnchangedHead();
					if (input.isCurrent?.() === false) throw new StaleContextProjectionError();
					recallLedger.declarePreUpgradeEpoch({
						sessionId,
						branchId,
						generation,
						...(input.branchTipId ? { branchTipId: input.branchTipId } : {}),
					});
					for (const draft of recallDrafts) {
						if (!input.commitRecall) {
							throw new RecallAdmissionPublishError(
								new Error("recall projection commit is unavailable"),
							);
						}
						let admission: RecallAdmission;
						try {
							admission = input.commitRecall(draft);
						} catch (error) {
							throw new RecallAdmissionPublishError(error);
						}
						if (admission.kind !== "admitted") throw new RecallAdmissionPublishError(admission);
					}
					writeHead(projectedState, bodyJson);
				})();
				published = true;
				return recallFailure ? { messages, recallFailure } : { messages };
			} catch (error) {
				if (!(error instanceof RecallAdmissionPublishError)) throw error;
				const commitFailure: ProjectionRecallFailure = { stage: "commit", error: error.cause };
				input.db.transaction(() => {
					assertUnchangedHead();
					recallLedger.declarePreUpgradeEpoch({
						sessionId,
						branchId,
						generation,
						...(input.branchTipId ? { branchTipId: input.branchTipId } : {}),
					});
					writeHead(fallbackState, fallbackBodyJson);
				})();
				published = true;
				return { messages: fallbackMessages, recallFailure: recallFailure ?? commitFailure };
			}
		},
	};
}
export function withdrawContextProjection(
	db: Database,
	sessionId: string,
	branchId = "root",
	now = Date.now(),
): boolean {
	ensureContextProjectionSchema(db);
	const normalizedSessionId = sessionId.trim();
	const normalizedBranchId = branchId.trim();
	const head = readHead(db, normalizedSessionId, normalizedBranchId);
	if (!head) return false;
	db.transaction(() => {
		db.prepare(
			"DELETE FROM mctx_context_projection_heads WHERE session_id = ? AND branch_id = ?",
		).run(normalizedSessionId, normalizedBranchId);
		db.prepare(
			"UPDATE mctx_projection_epochs SET status = 'withdrawn', updated_at = ? WHERE id = ?",
		).run(now, head.epochId);
	})();
	dropSlot(normalizedSessionId, "projection-withdrawn");
	return true;
}
