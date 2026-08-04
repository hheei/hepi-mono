import { expect, test } from "bun:test";
import { createArtifactRegistry } from "../src/artifact.js";

test("allocates session artifact URLs and rejects cleared resources", () => {
	const registry = createArtifactRegistry();
	expect(registry.create("one")).toBe("artifact://1");
	expect(registry.create("two")).toBe("artifact://2");
	expect(registry.read("artifact://1")).toBe("one");
	expect(() => registry.read("artifact://3")).toThrow("Unknown artifact URL");
	expect(() => registry.read("/tmp/secret")).toThrow("Invalid artifact URL");
	registry.dispose();
	expect(() => registry.read("artifact://1")).toThrow("Unknown artifact URL");
});
