import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "#core/features/storage-db";
import {
	clearPersistedLkgSlot,
	createDbLkgPersistence,
	loadPersistedLkgSlot,
	parsePersistedLkgSlot,
	saveLkgSlotToDb,
} from "#core/hooks/lkg-persist";
import {
	dropSlot,
	getSlot,
	type LkgSlot,
	registerLkgPersistence,
	resetLkgSlotsForTest,
} from "#core/hooks/lkg-slot";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";

const slot: LkgSlot = {
	jsonPrefix: '{"messages":[]}',
	inputIdSeq: ["a", "b"],
	inputContentDigests: ["d1", "d2"],
	lastInputMessageId: "b",
	modelKey: "gpt",
	providerKey: "openai",
	capturedAt: 1,
};

describe("lkg-persist", () => {
	afterEach(() => {
		resetLkgSlotsForTest();
	});

	it("round-trips a slot through SQLite", () => {
		const db = new Database(":memory:");
		try {
			initializeDatabase(db);
			expect(saveLkgSlotToDb(db, "s1", slot)).toBe(true);
			expect(loadPersistedLkgSlot(db, "s1")).toEqual(slot);
			clearPersistedLkgSlot(db, "s1");
			expect(loadPersistedLkgSlot(db, "s1")).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	it("hydrates getSlot after an in-memory miss", () => {
		const db = new Database(":memory:");
		try {
			initializeDatabase(db);
			saveLkgSlotToDb(db, "s2", slot);
			resetLkgSlotsForTest();
			registerLkgPersistence(createDbLkgPersistence(db));
			expect(getSlot("s2")).toEqual(slot);
			dropSlot("s2");
			expect(getSlot("s2")).toBeUndefined();
			expect(loadPersistedLkgSlot(db, "s2")).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects malformed persisted JSON", () => {
		expect(
			parsePersistedLkgSlot({
				json_prefix: "{}",
				input_id_seq: "[1]",
				input_content_digests: '["d"]',
				last_input_message_id: "x",
				captured_at: 1,
			}),
		).toBeUndefined();
	});
});
