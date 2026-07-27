import { describe, expect, test } from "bun:test";
import { fmtCompactNumber, fmtDuration, fmtRate } from "../../src/core/ui/number.js";

describe("number formatting", () => {
	test("formats compact values without rollover artifacts", () => {
		expect(fmtCompactNumber(999.4)).toBe("999");
		expect(fmtCompactNumber(999.5)).toBe("1K");
		expect(fmtCompactNumber(12_345)).toBe("12.3K");
		expect(fmtCompactNumber(999_950)).toBe("1M");
		expect(fmtCompactNumber(-1)).toBe("?");
		expect(fmtCompactNumber(999.5, "lower")).toBe("1k");
		expect(fmtDuration(250)).toBe("250ms");
		expect(fmtDuration(1_250)).toBe("1.3s");
		expect(fmtDuration(0)).toBe("?");
		expect(fmtRate(25)).toBe("25.0");
		expect(fmtRate(Infinity)).toBe("?");
	});
});
