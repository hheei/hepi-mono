import { expect, test } from "vitest";
import { counted } from "../src/counted.js";

test("uses singular only when the count is 1", (): void => {
	expect(counted(0, "line")).toBe("0 lines");
	expect(counted(1, "line")).toBe("1 line");
	expect(counted(2, "line")).toBe("2 lines");
	expect(counted(1, "match", "matches")).toBe("1 match");
	expect(counted(2, "match", "matches")).toBe("2 matches");
	expect(counted(1, "fuzzy", "fuzzies")).toBe("1 fuzzy");
	expect(counted(2, "fuzzy", "fuzzies")).toBe("2 fuzzies");
	expect(counted(1, "fuzzy file")).toBe("1 fuzzy file");
	expect(counted(2, "fuzzy file")).toBe("2 fuzzy files");
});
