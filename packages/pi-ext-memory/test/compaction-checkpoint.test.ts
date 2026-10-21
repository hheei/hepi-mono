import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, SystemMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
	hydrateCompactionCheckpoints,
	installCompactionCheckpointDedup,
	isEquivalentSystemMessage,
	isSystemMessage,
	resolveEntrySystemMessage,
} from "../src/session-ledger/compaction-checkpoint.js";
import type { Entry } from "../src/session-ledger/types.js";

// Ensure deduplication is installed for baseline suite
installCompactionCheckpointDedup(SessionManager);

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			totalTokens: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function getCompactionEntry(manager: SessionManager, id: string): Entry {
	const entry = manager.getEntry(id);
	if (entry?.type !== "compaction") {
		throw new Error(`Expected compaction entry for ${id}`);
	}
	return entry;
}

describe("isSystemMessage", () => {
	test("validates valid SystemMessage objects", () => {
		expect(isSystemMessage({ role: "system", content: "hi" })).toBe(true);
		expect(isSystemMessage({ role: "system", sections: { a: "b" } })).toBe(true);
	});

	test("rejects non-system or invalid structures", () => {
		expect(isSystemMessage(null)).toBe(false);
		expect(isSystemMessage(undefined)).toBe(false);
		expect(isSystemMessage({ role: "user", content: "hi" })).toBe(false);
		expect(isSystemMessage({ role: "system" })).toBe(false);
		expect(isSystemMessage("not an object")).toBe(false);
	});
});

describe("isEquivalentSystemMessage", () => {
	test("returns true for identical references and objects with matching properties", () => {
		const a: SystemMessage = {
			role: "system",
			content: "hello",
			timestamp: Date.now(),
			sections: { rules: "be helpful" },
			toolsAdded: [{ name: "read", description: "read file", parameters: {} }],
		};
		const b: SystemMessage = {
			role: "system",
			content: "hello",
			timestamp: Date.now(),
			sections: { rules: "be helpful" },
			toolsAdded: [{ name: "read", description: "read file", parameters: {} }],
		};
		expect(isEquivalentSystemMessage(a, a)).toBe(true);
		expect(isEquivalentSystemMessage(a, b)).toBe(true);
	});

	test("returns false when content, sections, or tools differ", () => {
		const base: SystemMessage = {
			role: "system",
			content: "hello",
			timestamp: Date.now(),
			sections: { rules: "be helpful" },
			toolsAdded: [{ name: "read", description: "read file", parameters: {} }],
		};
		expect(isEquivalentSystemMessage(base, { ...base, content: "different" })).toBe(false);
		expect(isEquivalentSystemMessage(base, { ...base, sections: { rules: "different" } })).toBe(
			false,
		);
		expect(
			isEquivalentSystemMessage(base, {
				...base,
				toolsAdded: [{ name: "bash", description: "run bash", parameters: {} }],
			}),
		).toBe(false);
		expect(isEquivalentSystemMessage(base, null)).toBe(false);
		expect(isEquivalentSystemMessage(null, undefined)).toBe(false);
	});
});

describe("resolveEntrySystemMessage and hydrateCompactionCheckpoints", () => {
	test("resolves from compaction systemMessage or message entry", () => {
		const sysMsg: SystemMessage = {
			role: "system",
			content: "root system prompt",
			timestamp: Date.now(),
		};
		expect(resolveEntrySystemMessage({ type: "compaction", id: "c1", systemMessage: sysMsg })).toBe(
			sysMsg,
		);
		expect(resolveEntrySystemMessage({ type: "message", id: "m1", message: sysMsg })).toBe(sysMsg);
		expect(
			resolveEntrySystemMessage({
				type: "message",
				id: "m2",
				message: { role: "user", content: "hi" },
			}),
		).toBeUndefined();
	});

	test("hydrates missing systemMessage by following checkpointEntryId", () => {
		const sysMsg: SystemMessage = {
			role: "system",
			content: "root system prompt",
			timestamp: Date.now(),
		};
		const c1: Entry = {
			type: "compaction",
			id: "c1",
			systemMessage: sysMsg,
		};
		const c2: Entry = {
			type: "compaction",
			id: "c2",
			checkpointEntryId: "c1",
		};
		const manager = {
			fileEntries: [c1, c2],
			byId: new Map<string, Entry>([
				["c1", c1],
				["c2", c2],
			]),
		};

		expect(c2.systemMessage).toBeUndefined();
		hydrateCompactionCheckpoints(manager);
		expect(c2.systemMessage).toBe(sysMsg);
	});

	test("hydrates from root system message if checkpoint points to initial message", () => {
		const rootSys: SystemMessage = {
			role: "system",
			content: "root prompt",
			timestamp: Date.now(),
		};
		const m1: Entry = {
			type: "message",
			id: "m1",
			message: rootSys,
		};
		const c1: Entry = {
			type: "compaction",
			id: "c1",
			checkpointEntryId: "m1",
		};
		const manager = {
			fileEntries: [m1, c1],
			byId: new Map<string, Entry>([
				["m1", m1],
				["c1", c1],
			]),
		};

		hydrateCompactionCheckpoints(manager);
		expect(c1.systemMessage).toBe(rootSys);
	});
});

describe("installCompactionCheckpointDedup reference counting and safety", () => {
	test("handles multiple install calls with reference counting and restores only on last dispose", () => {
		class FakeSessionManager {
			_appendEntry() {}
			_persist() {}
			_rewriteFile() {}
			_buildIndex() {}
		}
		const originalAppend = FakeSessionManager.prototype._appendEntry;

		const dispose1 = installCompactionCheckpointDedup(FakeSessionManager);
		expect(FakeSessionManager.prototype._appendEntry).not.toBe(originalAppend);

		const dispose2 = installCompactionCheckpointDedup(FakeSessionManager);
		// Still patched after second install
		expect(FakeSessionManager.prototype._appendEntry).not.toBe(originalAppend);

		// Dispose first owner
		dispose1();
		// Must STILL be patched because dispose2 owner is active!
		expect(FakeSessionManager.prototype._appendEntry).not.toBe(originalAppend);

		// Dispose second owner
		dispose2();
		// Now restored!
		expect(FakeSessionManager.prototype._appendEntry).toBe(originalAppend);

		// Idempotent extra dispose
		dispose2();
		expect(FakeSessionManager.prototype._appendEntry).toBe(originalAppend);
	});

	test("gracefully returns no-op on non-manager classes", () => {
		const dispose = installCompactionCheckpointDedup({});
		expect(typeof dispose).toBe("function");
		dispose();
	});
});

describe("installCompactionCheckpointDedup e2e persistence", () => {
	const tempFiles: string[] = [];

	afterEach(() => {
		for (const f of tempFiles) {
			if (existsSync(f)) {
				try {
					unlinkSync(f);
				} catch {}
			}
		}
		tempFiles.length = 0;
	});

	test("first compaction deduplicates against root message system prompt", () => {
		const sessionFile = join(
			tmpdir(),
			`dedup-test-root-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
		);
		tempFiles.push(sessionFile);

		const manager = SessionManager.create(tmpdir(), tmpdir());
		manager.setSessionFile(sessionFile);

		const promptText = "Root prompt text ".repeat(2000);
		const sysMessage: SystemMessage = {
			role: "system",
			content: promptText,
			timestamp: Date.now(),
		};
		const rootId = manager.appendMessage(sysMessage);

		const u1 = manager.appendMessage({ role: "user", content: "turn 1", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("reply 1"));
		const c1Id = manager.appendCompaction("Summary 1", u1, 100, {}, false, undefined);

		const diskLines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		const c1Line = diskLines.find((l) => JSON.parse(l).id === c1Id)!;
		const c1Entry = JSON.parse(c1Line);

		// First compaction points directly to rootId!
		expect(c1Entry.checkpointEntryId).toBe(rootId);
		expect(c1Entry.systemMessage).toBeUndefined();
		expect(c1Line.length).toBeLessThan(1000);

		// Reload session and verify hydration
		const reloaded = SessionManager.open(sessionFile);
		const rc1 = getCompactionEntry(reloaded, c1Id);
		expect(rc1.systemMessage).toBeDefined();
		expect(rc1.systemMessage?.content).toBe(promptText);
	});

	test("compaction entries deduplicate systemMessage on disk and hydrate in memory upon reload", () => {
		const sessionFile = join(
			tmpdir(),
			`dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
		);
		tempFiles.push(sessionFile);

		const manager = SessionManager.create(tmpdir(), tmpdir());
		manager.setSessionFile(sessionFile);

		// 1. Initial 50KB system prompt
		const promptText = "Rule instructions ".repeat(3000);
		const sysMessage: SystemMessage = {
			role: "system",
			content: promptText,
			sections: { rules: "be concise" },
			timestamp: Date.now(),
		};
		const rootId = manager.appendMessage(sysMessage);

		// 2. Turn 1 & Compaction 1
		const u1 = manager.appendMessage({ role: "user", content: "hi 1", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("reply 1"));
		const c1Id = manager.appendCompaction("Summary 1", u1, 100, {}, false, undefined);

		// 3. Turn 2 & Compaction 2 (identical system prompt -> should dedup!)
		const u2 = manager.appendMessage({ role: "user", content: "hi 2", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("reply 2"));
		const c2Id = manager.appendCompaction("Summary 2", u2, 100, {}, false, undefined);

		// 4. Verify disk sizes
		const diskLines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		const c1Line = diskLines.find((l) => JSON.parse(l).id === c1Id)!;
		const c2Line = diskLines.find((l) => JSON.parse(l).id === c2Id)!;
		const c1Entry = JSON.parse(c1Line);
		const c2Entry = JSON.parse(c2Line);

		expect(c1Entry.checkpointEntryId).toBe(rootId);
		expect(c2Entry.checkpointEntryId).toBe(c1Id);
		expect(c1Entry.systemMessage).toBeUndefined();
		expect(c2Entry.systemMessage).toBeUndefined();

		// 5. Reload session from disk
		const reloaded = SessionManager.open(sessionFile);
		const reloadedC1 = getCompactionEntry(reloaded, c1Id);
		const reloadedC2 = getCompactionEntry(reloaded, c2Id);

		// Hydrated in memory
		expect(reloadedC1.systemMessage).toBeDefined();
		expect(reloadedC2.systemMessage).toBeDefined();
		// In-memory reference is shared (0 extra heap consumption)
		expect(reloadedC1.systemMessage).toBe(reloadedC2.systemMessage);

		// Context projection correctly recovers leading system message
		const proj = reloaded.buildSessionProjection();
		expect(proj.messages.length).toBeGreaterThan(0);
		expect(proj.messages[0]?.role).toBe("system");
		const firstContent = (proj.messages[0] as { content?: unknown })?.content;
		expect(firstContent).toBe(promptText);
	});

	test("_rewriteFile materializes systemMessage defensively when ancestor is missing or unhydrated", () => {
		const sessionFile = join(
			tmpdir(),
			`dedup-test-rewrite-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
		);
		tempFiles.push(sessionFile);

		const manager = SessionManager.create(tmpdir(), tmpdir());
		manager.setSessionFile(sessionFile);

		const prompt = "Checkpoint prompt ".repeat(500);
		const rootId = manager.appendMessage({
			role: "system",
			content: prompt,
			timestamp: Date.now(),
		});
		const u1 = manager.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("a1"));
		const c1Id = manager.appendCompaction("Sum 1", u1, 100, {}, false, undefined);

		const u2 = manager.appendMessage({ role: "user", content: "u2", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("a2"));
		const c2Id = manager.appendCompaction("Sum 2", u2, 100, {}, false, undefined);

		const managerWithInternals = manager as unknown as {
			_rewriteFile: () => void;
			fileEntries: Entry[];
			byId: Map<string, Entry>;
		};

		// 1. Rewrite with full closure: c1 and c2 preserve checkpointEntryId
		managerWithInternals._rewriteFile();
		let diskLines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		let c2Entry = JSON.parse(diskLines.find((l) => JSON.parse(l).id === c2Id)!);
		expect(c2Entry.checkpointEntryId).toBe(c1Id);
		expect(c2Entry.systemMessage).toBeUndefined();

		// 2. Simulate fork / pruning where ancestor c1 is detached from fileEntries,
		// and c2.systemMessage was unhydrated (undefined)
		const c2InMem = managerWithInternals.byId.get(c2Id)!;
		c2InMem.systemMessage = undefined; // simulate cold/unhydrated in memory
		managerWithInternals.fileEntries = managerWithInternals.fileEntries.filter(
			(e) => e.id !== c1Id && e.id !== rootId,
		);

		managerWithInternals._rewriteFile();

		diskLines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		c2Entry = JSON.parse(diskLines.find((l) => JSON.parse(l).id === c2Id)!);

		// c2 has defensively materialized full systemMessage from byId ancestor before deleting checkpointEntryId!
		expect(c2Entry.checkpointEntryId).toBeUndefined();
		expect(c2Entry.systemMessage).toBeDefined();
		expect(c2Entry.systemMessage.content).toBe(prompt);
	});

	test("sibling branch export materializes correctly when checkpoint points to sibling ancestor", () => {
		const sessionFile = join(
			tmpdir(),
			`dedup-test-sibling-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
		);
		tempFiles.push(sessionFile);

		const manager = SessionManager.create(tmpdir(), tmpdir());
		manager.setSessionFile(sessionFile);

		const prompt = "Branch prompt ".repeat(300);
		const _rootId = manager.appendMessage({
			role: "system",
			content: prompt,
			timestamp: Date.now(),
		});

		// Branch A: cA points to rootId
		const uA = manager.appendMessage({ role: "user", content: "uA", timestamp: Date.now() });
		const _cAId = manager.appendCompaction("Sum A", uA, 100, {}, false, undefined);

		// Branch B (sibling branch): cB points to cA
		const uB = manager.appendMessage({ role: "user", content: "uB", timestamp: Date.now() });
		const cBId = manager.appendCompaction("Sum B", uB, 100, {}, false, undefined);

		const managerWithInternals = manager as unknown as {
			_rewriteFile: () => void;
			fileEntries: Entry[];
			byId: Map<string, Entry>;
		};

		// Now export ONLY Branch B entries (cB and uB), omitting cA and rootId
		managerWithInternals.fileEntries = managerWithInternals.fileEntries.filter(
			(e) => e.id === cBId || e.id === uB,
		);

		managerWithInternals._rewriteFile();

		const diskLines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		const cBEntry = JSON.parse(diskLines.find((l) => JSON.parse(l).id === cBId)!);

		// Because sibling cA is omitted from fileEntries, cB must materialize full systemMessage
		expect(cBEntry.checkpointEntryId).toBeUndefined();
		expect(cBEntry.systemMessage).toBeDefined();
		expect(cBEntry.systemMessage.content).toBe(prompt);
	});
});
