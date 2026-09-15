import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Regression coverage for per-session cleanup wiring.
 *
 * Pi has no `session_deleted` event. The closest analogs are:
 *   - `session_shutdown` — graceful process exit (Ctrl+C, SIGTERM)
 *   - `session_before_switch` — user switches to a different session
 *     within the same Pi process
 *
 * Both are valid moments to drain caches keyed by the outgoing session
 * id. Without this, a long-running Pi process that switches sessions
 * many times leaks one entry per per-session map per switch.
 *
 * Counterpart to OpenCode `session.deleted` cleanup in
 * `event-handler.ts:262-276`.
 */

const INDEX_SRC = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
const HANDLER_SRC = readFileSync(join(import.meta.dirname, "../src/context-handler.ts"), "utf8");

const sessionBeforeSwitchHandlers = [
	...INDEX_SRC.matchAll(/pi\.on\("session_before_switch"[\s\S]*?\}\);/g),
].map((match) => match[0]);
const sessionShutdownHandlers = [
	...INDEX_SRC.matchAll(/pi\.on\("session_shutdown"[\s\S]*?\n\s*\}\);/g),
].map((match) => match[0]);

describe("clearContextHandlerSession internals", () => {
	// The function body must drain all three signal sets — historian
	// or compressor publish (or hash change in before_agent_start) can
	// add to all three, and a stale session id would keep an entry in
	// any of them indefinitely without this cleanup.
	const fn = HANDLER_SRC.match(/export function clearContextHandlerSession\([^{]*\{([\s\S]*?)\n\}/);

	test("function exists and is exported", () => {
		expect(fn).not.toBeNull();
	});

	const body = fn?.[1] ?? "";

	test("deletes from historyRefreshSessions", () => {
		expect(body).toContain("historyRefreshSessions.delete(sessionId)");
	});

	test("deletes from pendingMaterializationSessions", () => {
		// Pinned: this was missing before the parity audit. Without it,
		// a stale pendingMaterializationSessions entry would force the
		// pipeline to materialize pending ops on a session that no
		// longer exists.
		expect(body).toContain("pendingMaterializationSessions.delete(sessionId)");
	});

	test("deletes from systemPromptRefreshSessions", () => {
		// Pinned: was also missing pre-audit.
		expect(body).toContain("systemPromptRefreshSessions.delete(sessionId)");
	});
});

describe("Window session_before_switch handler wiring", () => {
	const body = sessionBeforeSwitchHandlers[sessionBeforeSwitchHandlers.length - 1] ?? "";

	test("handler is registered", () => {
		expect(body).not.toBe("");
	});

	test("handler resolves the OUTGOING session id (not the new target)", () => {
		expect(body).toContain("getSessionId()");
	});

	test("handler drains Window and projection caches", () => {
		expect(body).toContain("clearPiSystemPromptSession(");
		expect(body).toContain("clearContextHandlerSession(");
	});
});

describe("bridge-only session_before_switch cleanup", () => {
	const body = sessionBeforeSwitchHandlers[0] ?? "";

	test("clears the outgoing projection cache without Window cleanup", () => {
		expect(body).toContain("getSessionId?.()");
		expect(body).toContain("clearContextHandlerSession(");
		expect(body).not.toContain("clearPiSystemPromptSession(");
	});
});

describe("session_shutdown handlers drain per-session maps", () => {
	const windowBody = sessionShutdownHandlers[sessionShutdownHandlers.length - 1] ?? "";
	const bridgeBody = sessionShutdownHandlers[0] ?? "";

	test("Window shutdown handler exists and clears its context cache", () => {
		expect(windowBody).not.toBe("");
		expect(windowBody).toContain("clearContextHandlerSession(");
	});

	test("bridge-only shutdown clears projection cache after its runtime drain", () => {
		expect(bridgeBody).toContain("withTimeout(runtime.shutdown(), 5_000)");
		expect(bridgeBody).toContain("clearContextHandlerSession(");
	});
});
