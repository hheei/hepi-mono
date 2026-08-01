import { expect, test } from "bun:test";
import {
	type EmbeddingService,
	embeddingService,
	getService,
	provideService,
	registerExtensionLifecycle,
} from "../src/index.js";
import { createFakePiHost } from "./fixtures.js";

test("publishes the embedding capability only for its active lifecycle", async () => {
	const host = createFakePiHost();
	const service: EmbeddingService = {
		snapshot: () => ({ provider: "local", modelIdentity: "local:test", generation: 1 }),
		embed: async () => new Float32Array([1]),
		embedBatch: async () => new Map([["one", new Float32Array([1])]]),
	};

	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-ext-embed",
		start: (context) => {
			expect(provideService(context, embeddingService, service)).toBe(true);
		},
	});

	await host.emit("session_start");
	expect(getService(host.pi, embeddingService)).toBe(service);
	await host.emit("session_shutdown");
	expect(getService(host.pi, embeddingService)).toBeUndefined();
});
