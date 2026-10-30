import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CuratorSearchEntry,
	type CuratorServerCallbacks,
	type CuratorServerHandle,
	startCuratorServer,
} from "../src/curator-server.ts";
import type { ProviderAvailability } from "../src/gemini-search.ts";

// The curator HTTP surface is one session: routes share the closure's state, and
// markCompleted is the only completion entry point. These tests pin routing, the
// shared body/token gate, per-handler payload validation, and the completion race
// a search can lose while its provider call is in flight.

const SESSION = "session-token";
const ENTRY: CuratorSearchEntry = {
	answer: "answer",
	results: [{ title: "T", url: "https://example.test/a", domain: "example.test" }],
	provider: "exa",
};

// The fixture only needs the providers these tests exercise; availability is a
// plain name→boolean table, and a missing name is unavailable.
function availability(names: string[]): ProviderAvailability {
	return Object.fromEntries(names.map((name) => [name, true])) as ProviderAvailability;
}

let tempDir: string;
let originalAgentDir: string | undefined;
let handle: CuratorServerHandle | null = null;
let base = "";
let callbacks: CuratorServerCallbacks;

function createCallbacks(): CuratorServerCallbacks {
	return {
		onSubmit: vi.fn(),
		onCancel: vi.fn(),
		onProviderChange: vi.fn(),
		onAddSearch: vi.fn(async () => [ENTRY]),
		onAddSearchResults: vi.fn(),
		onSummarize: vi.fn(async () => ({ summary: "s", meta: { model: "m" } as never })),
		onRewriteQuery: vi.fn(async () => "rewritten"),
	};
}

async function start(available: string[] = ["all", "exa"]): Promise<void> {
	handle = await startCuratorServer(
		{
			queries: ["first"],
			sessionToken: SESSION,
			timeout: 60,
			availableProviders: availability(available),
			defaultProvider: "exa",
			searchProvider: "exa",
			summaryModels: [{ value: "m", label: "M" }],
			defaultSummaryModel: "m",
		},
		callbacks,
	);
	const address = handle.server.address() as AddressInfo;
	base = `http://127.0.0.1:${address.port}`;
}

async function post(
	path: string,
	body: Record<string, unknown> = {},
	token = SESSION,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token, ...body }),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await tick();
	}
	throw new Error("waitFor: condition not met");
}

beforeEach(async () => {
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	tempDir = await mkdtemp(join(tmpdir(), "pi-curator-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	callbacks = createCallbacks();
});

afterEach(async () => {
	handle?.close();
	handle = null;
	await rm(tempDir, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("routing", () => {
	test("unknown method/path pair is not found", async () => {
		await start();
		const res = await fetch(`${base}/nope`, { method: "POST", body: "{}" });

		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Not found");
	});

	test("GET / requires the session token", async () => {
		await start();
		const res = await fetch(`${base}/`);

		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Invalid session");
	});

	test("GET /state rejects a bad token and reports retained events", async () => {
		await start();
		const denied = await fetch(`${base}/state?session=wrong`);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({ ok: false, error: "Invalid session" });

		handle?.pushResult(0, ENTRY);
		const allowed = await fetch(`${base}/state?session=${SESSION}`);
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toMatchObject({
			ok: true,
			done: false,
			events: [{ event: "result", data: { queryIndex: 0, query: "first" } }],
		});
	});

	test("GET /events replays retained events as SSE", async () => {
		await start();
		handle?.pushResult(0, ENTRY);

		const controller = new AbortController();
		const res = await fetch(`${base}/events?session=${SESSION}`, { signal: controller.signal });
		const reader = res.body?.getReader();
		const chunk = await reader?.read();
		controller.abort();

		expect(res.status).toBe(200);
		expect(new TextDecoder().decode(chunk?.value)).toContain("event: result");
	});
});

describe("shared POST gate", () => {
	test("invalid token is rejected before the handler runs", async () => {
		await start();
		const { status, json } = await post("/provider", { provider: "exa" }, "wrong");

		expect(status).toBe(403);
		expect(json).toEqual({ ok: false, error: "Invalid session" });
		expect(callbacks.onProviderChange).not.toHaveBeenCalled();
	});

	test("non-object body is rejected", async () => {
		await start();
		const res = await fetch(`${base}/heartbeat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "null",
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ ok: false, error: "Invalid body" });
	});
});

describe("/provider", () => {
	test("unknown and unavailable providers are rejected", async () => {
		await start(["all"]);

		expect(await post("/provider", { provider: "not-a-provider" })).toEqual({
			status: 400,
			json: { ok: false, error: "Provider unavailable: not-a-provider" },
		});
		expect(await post("/provider", { provider: "brave" })).toEqual({
			status: 400,
			json: { ok: false, error: "Provider unavailable: brave" },
		});
		expect(callbacks.onProviderChange).not.toHaveBeenCalled();
	});

	test("an available provider is forwarded", async () => {
		await start();

		expect(await post("/provider", { provider: "exa" })).toEqual({
			status: 200,
			json: { ok: true },
		});
		await tick();
		expect(callbacks.onProviderChange).toHaveBeenCalledWith("exa");
	});
});

describe("/search", () => {
	test("validates query and provider before calling the callback", async () => {
		await start(["all"]);

		expect(await post("/search", { query: "  " })).toEqual({
			status: 400,
			json: { ok: false, error: "Invalid query" },
		});
		expect(await post("/search", { query: "q", provider: "" })).toEqual({
			status: 400,
			json: { ok: false, error: "Invalid provider" },
		});
		expect(await post("/search", { query: "q", provider: "brave" })).toEqual({
			status: 400,
			json: { ok: false, error: "Provider unavailable: brave" },
		});
		expect(callbacks.onAddSearch).not.toHaveBeenCalled();
	});

	test("indexes results and records them on the session", async () => {
		await start();
		const { status, json } = await post("/search", { query: " second ", provider: "exa" });

		expect(status).toBe(200);
		expect(json).toMatchObject({ ok: true, queryIndex: 1, query: "second", provider: "exa" });
		expect(callbacks.onAddSearch).toHaveBeenCalledWith("second", "exa");
		expect(callbacks.onAddSearchResults).toHaveBeenCalledWith([
			expect.objectContaining({ queryIndex: 1, query: "second" }),
		]);
	});

	test("records a provider failure as an error entry", async () => {
		callbacks.onAddSearch = vi.fn(async () => []);
		await start();
		const { status, json } = await post("/search", { query: "q" });

		expect(status).toBe(200);
		expect(json).toMatchObject({
			ok: true,
			error: "Search returned no provider results",
			provider: "exa",
		});
	});

	test("drops results that arrive after the session completed", async () => {
		let resolveSearch: ((entries: CuratorSearchEntry[]) => void) | undefined;
		callbacks.onAddSearch = vi.fn(
			() =>
				new Promise<CuratorSearchEntry[]>((resolve) => {
					resolveSearch = resolve;
				}),
		);
		await start();

		const searchPromise = post("/search", { query: "late" });
		await tick();
		expect(await post("/submit", { selected: [] })).toEqual({
			status: 200,
			json: { ok: true },
		});

		resolveSearch?.([ENTRY]);
		const search = await searchPromise;

		expect(search).toEqual({ status: 409, json: { ok: false, error: "Session closed" } });
		expect(callbacks.onAddSearchResults).not.toHaveBeenCalled();
	});

	test("rejects searches once the session completed", async () => {
		await start();
		await post("/submit", { selected: [] });

		expect(await post("/search", { query: "q" })).toEqual({
			status: 409,
			json: { ok: false, error: "Session closed" },
		});
		expect(callbacks.onAddSearch).not.toHaveBeenCalled();
	});
});

describe("/submit and /cancel", () => {
	test("submit validates the payload before completing", async () => {
		await start();

		expect(await post("/submit", { selected: [5] })).toMatchObject({ status: 400 });
		expect(await post("/submit", { selected: [], summary: 7 })).toEqual({
			status: 400,
			json: { ok: false, error: "Invalid summary" },
		});
		expect(await post("/submit", { selected: [], summaryMeta: { model: 1 } })).toEqual({
			status: 400,
			json: { ok: false, error: "Invalid summaryMeta" },
		});
		expect(callbacks.onSubmit).not.toHaveBeenCalled();
	});

	test("submit completes the session once and forwards the payload", async () => {
		await start();
		const first = await post("/submit", { selected: [], autoApproveRemainingSearches: true });
		const second = await post("/submit", { selected: [] });

		expect(first).toEqual({ status: 200, json: { ok: true } });
		expect(second).toEqual({
			status: 409,
			json: { ok: false, error: "Cannot submit in current state" },
		});
		await tick();
		expect(callbacks.onSubmit).toHaveBeenCalledTimes(1);
		expect(callbacks.onSubmit).toHaveBeenCalledWith({
			selectedQueryIndices: [],
			rawResults: false,
			autoApproveRemainingSearches: true,
		});
	});

	test("cancel completes once and reports its reason", async () => {
		await start();
		expect(await post("/cancel", { reason: "timeout" })).toEqual({
			status: 200,
			json: { ok: true },
		});
		expect(await post("/cancel", {})).toEqual({ status: 200, json: { ok: true } });
		expect(await post("/submit", { selected: [] })).toMatchObject({ status: 409 });

		await tick();
		expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
		expect(callbacks.onCancel).toHaveBeenCalledWith("timeout");
		expect(callbacks.onSubmit).not.toHaveBeenCalled();
	});

	test("events are unavailable once completed", async () => {
		await start();
		await post("/cancel", {});

		const res = await fetch(`${base}/events?session=${SESSION}`);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ ok: false, error: "No events available" });
	});
});

describe("/summarize and /rewrite", () => {
	test("a superseded summarize request answers 409", async () => {
		const resolvers: Array<(value: { summary: string; meta: never }) => void> = [];
		callbacks.onSummarize = vi.fn(
			() =>
				new Promise<{ summary: string; meta: never }>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		await start();

		const firstPromise = post("/summarize", { selected: [0] });
		await waitFor(() => resolvers.length === 1);
		const secondPromise = post("/summarize", { selected: [0] });
		await waitFor(() => resolvers.length === 2);
		resolvers[1]?.({ summary: "second", meta: {} as never });
		resolvers[0]?.({ summary: "first", meta: {} as never });

		expect(await secondPromise).toEqual({
			status: 200,
			json: { ok: true, summary: "second", meta: {} },
		});
		expect(await firstPromise).toEqual({
			status: 409,
			json: { ok: false, error: "Summarize request superseded" },
		});
	});

	test("summarize rejects an empty selection", async () => {
		await start();
		expect(await post("/summarize", { selected: [] })).toMatchObject({ status: 400 });
		expect(callbacks.onSummarize).not.toHaveBeenCalled();
	});

	test("rewrite forwards the trimmed query and validates input", async () => {
		await start();

		expect(await post("/rewrite", { query: "  old  " })).toEqual({
			status: 200,
			json: { ok: true, query: "rewritten" },
		});
		expect(callbacks.onRewriteQuery).toHaveBeenCalledWith("old", expect.anything());
		expect(await post("/rewrite", { query: "" })).toEqual({
			status: 400,
			json: { ok: false, error: "Invalid query" },
		});
	});

	test("rewrite reports a callback failure as 500", async () => {
		callbacks.onRewriteQuery = vi.fn(async () => {
			throw new Error("boom");
		});
		await start();

		expect(await post("/rewrite", { query: "q" })).toEqual({
			status: 500,
			json: { ok: false, error: "boom" },
		});
	});
});
