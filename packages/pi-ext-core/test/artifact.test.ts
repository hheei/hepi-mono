import { expect, test } from "bun:test";
import { createArtifactRegistry } from "../src/artifact.js";

test("shares artifacts across registries without exposing backing paths", () => {
	const first = createArtifactRegistry();
	const second = createArtifactRegistry();
	const one = first.create("one");
	const two = first.create("two");
	expect(one).toMatch(/^artifact:\/\/[1-9]\d*$/);
	expect(two).toMatch(/^artifact:\/\/[1-9]\d*$/);
	expect(second.read(one)).toBe("one");
	expect(second.read(two)).toBe("two");
	expect(() => second.read("artifact://999999999999999999999")).toThrow("Unknown artifact URL");
	expect(() => second.read("/tmp/secret")).toThrow("Invalid artifact URL");
	first.dispose();
	expect(second.read(one)).toBe("one");
	second.dispose();
});

test("append handle exposes reserved artifact URI before finalization", () => {
	const registry = createArtifactRegistry();
	const handle = registry.createAppend();
	expect(handle.uri).toMatch(/^artifact:\/\/[1-9]\d*$/);
	handle.append(new TextEncoder().encode("streamed"));
	expect(handle.finalize()).toBe(handle.uri);
	expect(registry.read(handle.uri)).toBe("streamed");
});
