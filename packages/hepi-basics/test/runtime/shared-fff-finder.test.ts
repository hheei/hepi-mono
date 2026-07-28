import { describe, expect, test } from "bun:test";
import { acquireSharedFffFinder } from "../../src/core/index.js";

describe("shared FFF finder", () => {
	test("reuses a finder until its final lease releases", () => {
		const key = `test-${crypto.randomUUID()}`;
		const finder = {};
		let created = 0;
		let destroyed = 0;
		const first = acquireSharedFffFinder(
			key,
			() => {
				created += 1;
				return finder;
			},
			() => {
				destroyed += 1;
			},
		);
		const second = acquireSharedFffFinder(
			key,
			() => {
				created += 1;
				return {};
			},
			() => {
				destroyed += 1;
			},
		);

		expect(first.finder).toBe(finder);
		expect(second.finder).toBe(finder);
		expect(created).toBe(1);
		first.release();
		expect(destroyed).toBe(0);
		second.release();
		second.release();
		expect(destroyed).toBe(1);
	});
});
