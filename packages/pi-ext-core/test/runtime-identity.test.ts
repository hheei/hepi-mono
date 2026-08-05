import { expect, test } from "bun:test";
import { type RuntimeHost, runtimeIdentity } from "../src/runtime-identity.js";

test("uses the shared Pi event bus as runtime identity", () => {
	const events = {};
	const pi = { events };

	expect(runtimeIdentity(pi as RuntimeHost)).toBe(events);
});

test("falls back to the host when events is unavailable", () => {
	const pi = { events: undefined };

	expect(runtimeIdentity(pi as unknown as RuntimeHost)).toBe(pi);
});
