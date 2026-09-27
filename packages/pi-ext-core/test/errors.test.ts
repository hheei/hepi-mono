import { describe, expect, test } from "vitest";
import { abortError, errorMessage, throwIfAborted } from "../src/index.js";

describe("errorMessage", () => {
	test("reads the message of an Error and stringifies other values", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("boom")).toBe("boom");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});

describe("abortError", () => {
	test("names the cancellation error so callers can classify it", () => {
		const error = abortError();
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("Operation aborted");
	});

	test("passes an existing cancellation reason through unchanged", () => {
		const reason = new Error("surface closed by the user");
		reason.name = "AbortError";
		expect(abortError(reason)).toBe(reason);
	});

	test("ignores a reason that is not itself a cancellation", () => {
		expect(abortError(new Error("timed out")).message).toBe("Operation aborted");
		expect(abortError("whatever").name).toBe("AbortError");
	});

	test("replaces Node's generic DOMException reason with a stable message", () => {
		const controller = new AbortController();
		controller.abort();
		const error = abortError(controller.signal.reason);
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("Operation aborted");
	});
});

describe("throwIfAborted", () => {
	test("does nothing without a signal and while the signal has not fired", () => {
		expect(() => throwIfAborted()).not.toThrow();
		const controller = new AbortController();
		expect(() => throwIfAborted(controller.signal)).not.toThrow();
		controller.abort();
		expect(() => throwIfAborted(controller.signal)).toThrow();
	});

	test("throws the signal's own cancellation reason when it carries one", () => {
		const controller = new AbortController();
		const reason = new Error("cancelled by the test");
		reason.name = "AbortError";
		controller.abort(reason);
		expect(() => throwIfAborted(controller.signal)).toThrow(reason);
	});
});
