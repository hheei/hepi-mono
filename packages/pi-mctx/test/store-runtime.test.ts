import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMctxStore } from "../src/store.js";

test("opens the MCTX store through Bun SQLite", async (): Promise<void> => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mctx-bun-"));
	try {
		const store = await openMctxStore(join(directory, "context.db"));
		try {
			const partition = store.getOrCreatePartition(`dir:${"a".repeat(64)}`, "session-1");
			expect(partition).toMatchObject({
				revision: 0,
			});
			expect(
				store.syncHistoryTags(partition, [
					{ kind: "message", entryId: "entry-1", source: "fresh Bun store" },
				]),
			).toMatchObject({
				partition: { revision: 1 },
				tags: [{ kind: "message", entryId: "entry-1", tagNumber: 1, status: "active" }],
			});
		} finally {
			store.close();
		}
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
