import { expect, test } from "bun:test";
import { registerExtensionLifecycle } from "../src/lifecycle.js";
import { createFakePiHost } from "./fixtures.js";

test("makes retained handlers from an earlier reload inert", async () => {
	const host = createFakePiHost();
	const calls: string[] = [];
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-example",
		start: (context) => {
			calls.push("first:start");
			context.resources.add("first", () => {
				calls.push("first:shutdown");
			});
		},
	});
	await host.emit("session_start");
	await host.emit("session_shutdown");

	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-example",
		start: (context) => {
			calls.push("second:start");
			context.resources.add("second", () => {
				calls.push("second:shutdown");
			});
		},
	});
	await host.emit("session_start");
	await host.emit("session_shutdown");

	expect(calls).toEqual(["first:start", "first:shutdown", "second:start", "second:shutdown"]);
});

test("cleans active resources before replacing same-key lifecycle", async () => {
	const host = createFakePiHost();
	const calls: string[] = [];
	let firstLive = false;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-active-reload",
		start: (context) => {
			calls.push("first:start");
			firstLive = true;
			context.resources.add("first", () => {
				firstLive = false;
				calls.push("first:shutdown");
			});
		},
	});
	await host.emit("session_start");

	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-active-reload",
		start: (context) => {
			expect(firstLive).toBe(false);
			expect(calls).toEqual(["first:start", "first:shutdown"]);
			calls.push("second:start");
			context.resources.add("second", () => {
				calls.push("second:shutdown");
			});
		},
	});
	await host.emit("session_start");
	await host.emit("session_shutdown");

	expect(calls).toEqual(["first:start", "first:shutdown", "second:start", "second:shutdown"]);
});

test("cleans registered resources when start fails", async () => {
	const host = createFakePiHost();
	const calls: string[] = [];
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-failing",
		start: (context) => {
			context.resources.add("resource", () => {
				calls.push("cleanup");
			});
			throw new Error("start failed");
		},
	});

	await expect(host.emit("session_start")).rejects.toThrow("start failed");
	expect(calls).toEqual(["cleanup"]);
});
