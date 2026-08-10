import { expect, test } from "bun:test";
import { createOutputRegistry } from "../src/output.js";

test("shares outputs across registries without exposing backing paths", () => {
	const first = createOutputRegistry();
	const second = createOutputRegistry();
	const one = first.create("one");
	const two = first.create("two");
	expect(one).toMatch(/^output:\/\/[1-9]\d*$/);
	expect(two).toMatch(/^output:\/\/[1-9]\d*$/);
	expect(second.read(one)).toBe("one");
	expect(second.read(two)).toBe("two");
	expect(() => second.read("output://999999999999999999999")).toThrow("Unknown output URL");
	expect(() => second.read("/tmp/secret")).toThrow("Invalid output URL");
	first.dispose();
	expect(second.read(one)).toBe("one");
	second.dispose();
});

test("reads outputs with Pi one-based offset and line limit", () => {
	const registry = createOutputRegistry();
	const uri = registry.create("one\ntwo\nthree");
	expect(registry.read(uri, { offset: 2, limit: 1 })).toBe("two");
	expect(registry.read(uri, { offset: 2 })).toBe("two\nthree");
	expect(() => registry.read(uri, { offset: 4 })).toThrow("Offset 4 is beyond end of output");
});

test("append handle exposes reserved output URI before finalization", () => {
	const registry = createOutputRegistry();
	const handle = registry.createAppend();
	expect(handle.uri).toMatch(/^output:\/\/[1-9]\d*$/);
	handle.append(new TextEncoder().encode("streamed"));
	expect(handle.finalize()).toBe(handle.uri);
	expect(registry.read(handle.uri)).toBe("streamed");
});
