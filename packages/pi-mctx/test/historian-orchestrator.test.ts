import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import {
	MCTX_HISTORIAN_LEASE_TTL_MS,
	type MctxHistorianExecutor,
	runMctxHistorian,
} from "../src/historian-orchestrator.js";
import type {
	MctxCompartmentDraft,
	MctxCompartmentPublication,
	MctxHistorianLease,
	MctxPartition,
} from "../src/store.js";

const model = { api: "test", provider: "test", id: "historian" } as Model<Api>;
const partition = { projectIdentity: "project", sessionId: "session", revision: 0 } as const;
const source = { entryIds: ["entry-1", "entry-2"], fingerprint: "snapshot" } as const;
const validOutput = JSON.stringify({
	tier: "m0",
	sourceStartEntryId: "entry-1",
	sourceEndEntryId: "entry-2",
	renderedPayload: "summary",
});

function publication(draft: MctxCompartmentDraft): MctxCompartmentPublication {
	return {
		partition: { ...partition, revision: 1 },
		compartment: { ...draft, sequence: 0, publishedRevision: 1 },
	};
}

function store(options: {
	readonly lease?: MctxHistorianLease;
	readonly publish?: MctxCompartmentPublication;
}) {
	let releases = 0;
	const lease = options.lease ?? {
		partition,
		ownerToken: "owner",
		expiresAtMs: 60_000,
	};
	return {
		store: {
			acquireHistorianLease: (current: MctxPartition, owner: string, ttlMs: number) => {
				expect(current).toEqual(partition);
				expect(owner).toBe("owner");
				expect(ttlMs).toBe(MCTX_HISTORIAN_LEASE_TTL_MS);
				return options.lease === undefined ? lease : options.lease;
			},
			renewHistorianLease: (current: MctxHistorianLease) => current,
			publishCompartment: (_current: MctxPartition, draft: MctxCompartmentDraft) =>
				options.publish === undefined ? undefined : publication(draft),
			releaseHistorianLease: (released: MctxHistorianLease) => {
				expect(released).toEqual(lease);
				releases++;
			},
		},
		releases: (): number => releases,
	};
}

function executor(outputs: readonly string[]): MctxHistorianExecutor {
	let index = 0;
	return async () => {
		const output = outputs[index++];
		if (output === undefined) throw new Error("Unexpected historian execution");
		return { kind: "completed", output };
	};
}

function failed(kind: "transient" | "invalid-request", message: string) {
	return { kind: "failed" as const, failure: { kind, message } };
}

function request(overrides: Record<string, unknown> = {}): Parameters<typeof runMctxHistorian>[0] {
	return {
		context: {} as ExtensionLifecycleContext,
		model,
		partition,
		source,
		sourceText: "history",
		signal: new AbortController().signal,
		leaseOwnerToken: "owner",
		...overrides,
	} as unknown as Parameters<typeof runMctxHistorian>[0];
}

test("skips an occupied partition without executing or releasing", async (): Promise<void> => {
	const { store: heldStore, releases } = store({});
	const result = await runMctxHistorian(
		request({ store: { ...heldStore, acquireHistorianLease: () => undefined } }),
		async () => {
			throw new Error("must not execute");
		},
	);
	expect(result).toEqual({ kind: "skipped", reason: "lease-held" });
	expect(releases()).toBe(0);
});

test("publishes valid primary output and releases its lease", async (): Promise<void> => {
	const { store: activeStore, releases } = store({
		publish: publication({
			tier: "m0",
			sourceStartEntryId: "entry-1",
			sourceEndEntryId: "entry-2",
			sourceFingerprint: "snapshot",
			renderedPayload: "summary",
		}),
	});
	const result = await runMctxHistorian(request({ store: activeStore }), executor([validOutput]));
	expect(result).toMatchObject({ kind: "published", repaired: false });
	expect(releases()).toBe(1);
});

test("renews an active lease and releases its latest snapshot", async (): Promise<void> => {
	const initialLease: MctxHistorianLease = { partition, ownerToken: "owner", expiresAtMs: 60_000 };
	let renewals = 0;
	let released: MctxHistorianLease | undefined;
	const result = await runMctxHistorian(
		request({
			leaseRenewalIntervalMs: 1,
			store: {
				acquireHistorianLease: () => initialLease,
				renewHistorianLease: (current: MctxHistorianLease, ttlMs: number) => {
					expect(ttlMs).toBe(MCTX_HISTORIAN_LEASE_TTL_MS);
					renewals++;
					return { ...current, expiresAtMs: current.expiresAtMs + ttlMs };
				},
				publishCompartment: (_current: MctxPartition, draft: MctxCompartmentDraft) =>
					publication(draft),
				releaseHistorianLease: (lease: MctxHistorianLease) => {
					released = lease;
				},
			},
		}),
		async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
			return { kind: "completed", output: validOutput };
		},
	);
	expect(result).toMatchObject({ kind: "published", repaired: false });
	expect(renewals).toBeGreaterThan(0);
	expect(released?.expiresAtMs).toBeGreaterThan(initialLease.expiresAtMs);
});

test("retries a transient failure at most twice before publishing", async (): Promise<void> => {
	const { store: activeStore } = store({
		publish: publication({
			tier: "m0",
			sourceStartEntryId: "entry-1",
			sourceEndEntryId: "entry-2",
			sourceFingerprint: "snapshot",
			renderedPayload: "summary",
		}),
	});
	let calls = 0;
	const result = await runMctxHistorian(
		request({ store: activeStore, retryDelayMs: () => 0 }),
		async () => {
			calls++;
			return calls < 3
				? failed("transient", "rate limited")
				: { kind: "completed", output: validOutput };
		},
	);
	expect(result).toMatchObject({ kind: "published", repaired: false });
	expect(calls).toBe(3);
});

test("does not retry a non-transient completion failure", async (): Promise<void> => {
	const { store: activeStore } = store({});
	let calls = 0;
	const result = await runMctxHistorian(
		request({ store: activeStore, retryDelayMs: () => 0 }),
		async () => {
			calls++;
			return failed("invalid-request", "bad request");
		},
	);
	expect(result).toEqual({
		kind: "failed",
		reason: "bad request",
		failureKind: "invalid-request",
		attempt: 1,
	});
	expect(calls).toBe(1);
});

test("cancels a pending transient retry without another completion", async (): Promise<void> => {
	const controller = new AbortController();
	const { store: activeStore } = store({});
	let calls = 0;
	const running = runMctxHistorian(
		request({ store: activeStore, signal: controller.signal, retryDelayMs: () => 10_000 }),
		async () => {
			calls++;
			queueMicrotask(() => controller.abort());
			return failed("transient", "timed out");
		},
	);
	expect(await running).toEqual({ kind: "cancelled" });
	expect(calls).toBe(1);
});

test("shares the retry budget with validation repair", async (): Promise<void> => {
	const { store: activeStore } = store({});
	let calls = 0;
	const outcomes = [
		failed("transient", "rate limited"),
		failed("transient", "rate limited"),
		{ kind: "completed" as const, output: "not json" },
		failed("transient", "still rate limited"),
	];
	const result = await runMctxHistorian(
		request({ store: activeStore, retryDelayMs: () => 0 }),
		async () => {
			const outcome = outcomes[calls++];
			if (outcome === undefined) throw new Error("Unexpected historian execution");
			return outcome;
		},
	);
	expect(result).toEqual({
		kind: "failed",
		reason: "still rate limited",
		failureKind: "transient",
		attempt: 4,
	});
	expect(calls).toBe(4);
});

test("cancels without publication when lease renewal loses ownership", async (): Promise<void> => {
	let published = false;
	let releases = 0;
	const result = await runMctxHistorian(
		request({
			leaseRenewalIntervalMs: 1,
			store: {
				acquireHistorianLease: () => ({ partition, ownerToken: "owner", expiresAtMs: 60_000 }),
				renewHistorianLease: () => undefined,
				publishCompartment: () => {
					published = true;
					return publication({
						tier: "m0",
						sourceStartEntryId: "entry-1",
						sourceEndEntryId: "entry-2",
						sourceFingerprint: "snapshot",
						renderedPayload: "summary",
					});
				},
				releaseHistorianLease: () => void releases++,
			},
		}),
		async (_context, completion) =>
			await new Promise((resolve) => {
				completion.signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
					once: true,
				});
			}),
	);
	expect(result).toEqual({ kind: "cancelled" });
	expect(published).toBeFalse();
	expect(releases).toBe(1);
});

test("repairs invalid primary output once before publication", async (): Promise<void> => {
	const { store: activeStore, releases } = store({
		publish: publication({
			tier: "m0",
			sourceStartEntryId: "entry-1",
			sourceEndEntryId: "entry-2",
			sourceFingerprint: "snapshot",
			renderedPayload: "summary",
		}),
	});
	const result = await runMctxHistorian(
		request({ store: activeStore }),
		executor(["not json", validOutput]),
	);
	expect(result).toMatchObject({ kind: "published", repaired: true });
	expect(releases()).toBe(1);
});

test("repairs a completion that violates the graph-required tier", async (): Promise<void> => {
	const { store: activeStore, releases } = store({
		publish: publication({
			tier: "m1",
			sourceStartEntryId: "entry-1",
			sourceEndEntryId: "entry-2",
			sourceFingerprint: "snapshot",
			renderedPayload: "summary",
		}),
	});
	const m1Output = JSON.stringify({
		tier: "m1",
		sourceStartEntryId: "entry-1",
		sourceEndEntryId: "entry-2",
		renderedPayload: "summary",
	});
	const result = await runMctxHistorian(
		request({ store: activeStore, expectedTier: "m1" }),
		executor([validOutput, m1Output]),
	);
	expect(result).toMatchObject({ kind: "published", repaired: true });
	expect(releases()).toBe(1);
});

test("returns stale when publication CAS loses and releases the lease", async (): Promise<void> => {
	const { store: activeStore, releases } = store({});
	const result = await runMctxHistorian(request({ store: activeStore }), executor([validOutput]));
	expect(result).toEqual({ kind: "stale" });
	expect(releases()).toBe(1);
});
