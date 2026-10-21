import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
	createServiceKey,
	getService,
	provideService,
	registerExtensionLifecycle,
} from "../src/index.js";
import { createFakePiHost } from "./fixtures.js";

interface Database {
	readonly name: string;
}

const database = createServiceKey<Database>("@hheei/pi-database/service");

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
