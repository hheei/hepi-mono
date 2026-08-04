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
			expect(store.getOrCreatePartition(`dir:${"a".repeat(64)}`, "session-1")).toMatchObject({
				revision: 0,
			});
		} finally {
			store.close();
		}
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
