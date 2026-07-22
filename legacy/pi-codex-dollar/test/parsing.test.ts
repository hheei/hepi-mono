import { test } from "bun:test";
import assert from "node:assert/strict";
import { extractDollarSkillToken } from "../src/index.js";

assert.deepEqual(extractDollarSkillToken(["Use $lib"], 0, "Use $lib".length), {
	query: "lib",
	prefix: "$lib",
});

assert.deepEqual(extractDollarSkillToken(["Use $"], 0, "Use $".length), {
	query: "",
	prefix: "$",
});

assert.deepEqual(extractDollarSkillToken(["($deploy-plan"], 0, "($deploy-plan".length), {
	query: "deploy-plan",
	prefix: "$deploy-plan",
});

assert.equal(extractDollarSkillToken(["Cost is $5"], 0, "Cost is $5".length), null);
assert.equal(
	extractDollarSkillToken(["Use $skill:librarian"], 0, "Use $skill:librarian".length),
	null,
);
assert.equal(extractDollarSkillToken(["Use abc$lib"], 0, "Use abc$lib".length), null);

console.log("parsing ok");

test("parsing", () => {});
