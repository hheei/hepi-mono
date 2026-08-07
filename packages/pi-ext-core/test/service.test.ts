import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createServiceKey,
	ensureKnowledgeInjectionCoordinator,
	getService,
	provideService,
	registerExtensionLifecycle,
	waitForService,
} from "../src/index.js";
import { createFakePiHost } from "./fixtures.js";

interface Database {
	readonly name: string;
}

const database = createServiceKey<Database>("@hheei/pi-database/service");

test("lets an early consumer continue without blocking a later provider", async () => {
	const host = createFakePiHost();
	const calls: string[] = [];
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-consumer",
		start: (context) => {
			calls.push("consumer:start");
			void waitForService(context.pi, database, { signal: context.signal })
				.then((value) => {
					calls.push(`consumer:${value.name}`);
				})
				.catch((error: unknown) => {
					throw error;
				});
		},
	});
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-database",
		start: (context) => {
			calls.push("provider:start");
			expect(provideService(context, database, { name: "primary" })).toBe(true);
		},
	});

	await host.emit("session_start");
	await Promise.resolve();

	expect(calls).toEqual(["consumer:start", "provider:start", "consumer:primary"]);
});

test("keeps the first provider and removes it at shutdown", async () => {
	const host = createFakePiHost();
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-database-first",
		start: (context) => {
			expect(provideService(context, database, { name: "first" })).toBe(true);
		},
	});
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-database-second",
		start: (context) => {
			expect(provideService(context, database, { name: "second" })).toBe(false);
		},
	});

	await host.emit("session_start");
	expect(getService(host.pi, database)).toEqual({ name: "first" });
	const secondFacade = { events: host.pi.events } as unknown as ExtensionAPI;
	expect(getService(secondFacade, database)).toEqual({ name: "first" });
	await host.emit("session_shutdown");
	expect(getService(host.pi, database)).toBeUndefined();
});

test("shares Service state with a separately evaluated core module", async () => {
	const host = createFakePiHost();
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-database-provider",
		start: (context) => {
			expect(provideService(context, database, { name: "shared" })).toBe(true);
		},
	});
	await host.emit("session_start");

	const duplicate = (await import(
		new URL("../src/service.ts?duplicate=1", import.meta.url).href
	)) as typeof import("../src/service.js");
	const duplicateKey = duplicate.createServiceKey<Database>(database.id);
	expect(duplicate.getService(host.pi, duplicateKey)).toEqual({ name: "shared" });

	await host.emit("session_shutdown");
});

test("rejects a cancelled Service wait", async () => {
	const host = createFakePiHost();
	const controller = new AbortController();
	const waiting = waitForService(host.pi, database, { signal: controller.signal });
	controller.abort();

	await expect(waiting).rejects.toThrow();
});

test("rejects a Service wait on lifecycle shutdown", async () => {
	const host = createFakePiHost();
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-waiter",
		start: () => undefined,
	});
	const waiting = waitForService(host.pi, database, { signal: new AbortController().signal });

	await host.emit("session_start");
	await host.emit("session_shutdown");

	await expect(waiting).rejects.toThrow("Service wait aborted");
});

test("does not publish a Service from a continuation after shutdown", async () => {
	const host = createFakePiHost();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let lateError: unknown;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-late-provider",
		start: (context) => {
			void gate.then(() => {
				try {
					provideService(context, database, { name: "late" });
				} catch (error) {
					lateError = error;
				}
			});
		},
	});

	await host.emit("session_start");
	await host.emit("session_shutdown");
	if (release === undefined) throw new Error("Expected late provider release");
	release();
	await Promise.resolve();

	expect(lateError).toBeInstanceOf(Error);
	expect(getService(host.pi, database)).toBeUndefined();
});

test("keeps disabled knowledge injection terminal for its lifecycle generation", async () => {
	const host = createFakePiHost();
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-knowledge-gate",
		start: (context) => {
			const coordinator = ensureKnowledgeInjectionCoordinator(host.pi, context);
			coordinator.setMctxEligibility({ generation: "mctx-1", eligible: true });
			expect(coordinator.state().mctxConfigured).toBe(true);
			const mctxLease = coordinator.claim({
				owner: "mctx-owned",
				generation: "mctx-1",
				reason: "test owner",
			});
			expect(mctxLease).toBeDefined();
			expect(
				coordinator.claim({
					owner: "hindsight-owned",
					generation: "hindsight-1",
					reason: "test fallback",
				}),
			).toBeUndefined();
			coordinator.disable({ generation: "mctx-1", reason: "provider unavailable" });
			expect(coordinator.state()).toMatchObject({ owner: "disabled", generation: "mctx-1" });
			expect(
				coordinator.claim({
					owner: "mctx-owned",
					generation: "mctx-1",
					reason: "retry in same lifecycle",
				}),
			).toBeUndefined();
			expect(mctxLease === undefined ? false : coordinator.release(mctxLease)).toBe(false);
		},
	});

	await host.emit("session_start");
});
