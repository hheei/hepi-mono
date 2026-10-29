import { join } from "node:path";
import { expect, test } from "vitest";
import { attachChildMailbox, createMailboxTransport } from "../src/mailbox.js";
import { DEFAULT_MAX_BUFFERED_EVENTS } from "../src/protocol.js";
import { openStateDb } from "../src/state-db.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT = "parent-1";
const CHILD = "agent-1";

function pendingEvents(filePath: string): Array<{ payload: string }> {
	return openStateDb(filePath)
		.prepare(
			`SELECT payload FROM commands
			 WHERE parent_session_id = ? AND subagent_id = ? AND operation = 'event' AND status = 'pending'
			 ORDER BY created_at`,
		)
		.all(PARENT, CHILD) as Array<{ payload: string }>;
}

test("times out on its deadline even when the queued row is gone", async () => {
	await withTempDir("pi-subagents-mailbox-", async (directory) => {
		const filePath = join(directory, "state.sqlite");
		const transport = createMailboxTransport({
			filePath,
			parentSessionId: PARENT,
			handleRequest: async () => null,
			pollMs: 5,
		});
		try {
			const pending = transport.request(CHILD, "get_state", {}, { timeoutMs: 40 });
			// Another writer deleting the row used to leave this waiter polling forever.
			openStateDb(filePath).prepare("DELETE FROM commands").run();
			await expect(pending).rejects.toThrow(/No answer for/u);
		} finally {
			transport.close();
		}
	});
});

test("closing the transport settles a request that is still waiting", async () => {
	await withTempDir("pi-subagents-mailbox-", async (directory) => {
		const transport = createMailboxTransport({
			filePath: join(directory, "state.sqlite"),
			parentSessionId: PARENT,
			handleRequest: async () => null,
			pollMs: 5,
		});
		const pending = transport.request(CHILD, "get_state", {}, { timeoutMs: 5_000 });
		transport.close();
		await expect(pending).rejects.toThrow(/transport was closed/u);
	});
});

test("keeps only the newest queued events for a child nobody is reading", async () => {
	await withTempDir("pi-subagents-mailbox-", async (directory) => {
		const filePath = join(directory, "state.sqlite");
		const mailbox = attachChildMailbox({
			filePath,
			parentSessionId: PARENT,
			subagentId: CHILD,
			handleRequest: async () => null,
		});
		mailbox.start();
		try {
			const total = DEFAULT_MAX_BUFFERED_EVENTS + 40;
			for (let index = 0; index < total; index += 1) mailbox.sendEvent({ turnIndex: index });
			const queued = pendingEvents(filePath);
			expect(queued).toHaveLength(DEFAULT_MAX_BUFFERED_EVENTS);
			// The newest snapshots survive; the oldest progress frames are the ones dropped.
			expect(queued.at(-1)?.payload).toBe(JSON.stringify({ turnIndex: total - 1 }));
			expect(queued[0]?.payload).toBe(
				JSON.stringify({ turnIndex: total - DEFAULT_MAX_BUFFERED_EVENTS }),
			);
		} finally {
			mailbox.close();
		}
	});
});
