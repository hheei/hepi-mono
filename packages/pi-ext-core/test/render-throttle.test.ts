import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createRenderThrottle,
	HOST_FRAME_INTERVAL_MS,
	STREAM_REPAINT_INTERVAL_MS,
} from "../src/render-throttle.js";

describe("render throttle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("keeps the two agreed windows distinct", () => {
		expect(HOST_FRAME_INTERVAL_MS).toBe(16);
		expect(STREAM_REPAINT_INTERVAL_MS).toBe(100);
	});

	test("renders the first request immediately and collapses a burst into one trailing render", () => {
		const render = vi.fn();
		const throttle = createRenderThrottle(render);
		throttle.request();
		expect(render).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 50; index += 1) throttle.request();
		expect(render).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(STREAM_REPAINT_INTERVAL_MS);
		expect(render).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(STREAM_REPAINT_INTERVAL_MS * 5);
		expect(render).toHaveBeenCalledTimes(2);
		throttle.dispose();
	});

	test("opens a new window after the trailing render", () => {
		const render = vi.fn();
		const throttle = createRenderThrottle(render, 20);
		throttle.request();
		vi.advanceTimersByTime(20);
		throttle.request();
		expect(render).toHaveBeenCalledTimes(2);
		throttle.request();
		vi.advanceTimersByTime(20);
		expect(render).toHaveBeenCalledTimes(3);
		throttle.dispose();
	});

	test("dispose drops a pending render and makes later calls inert", () => {
		const render = vi.fn();
		const throttle = createRenderThrottle(render);
		throttle.request();
		throttle.request();
		throttle.dispose();
		vi.advanceTimersByTime(STREAM_REPAINT_INTERVAL_MS * 3);
		expect(render).toHaveBeenCalledTimes(1);
		throttle.request();
		vi.advanceTimersByTime(STREAM_REPAINT_INTERVAL_MS);
		expect(render).toHaveBeenCalledTimes(1);
	});

	test("flush delivers the pending render without waiting for the window", () => {
		const render = vi.fn();
		const throttle = createRenderThrottle(render);
		throttle.request();
		throttle.request();
		expect(render).toHaveBeenCalledTimes(1);
		throttle.flush();
		// The last streaming snapshot must reach the caller even when the window never expires,
		// because the caller is about to publish its final result and stop repainting.
		expect(render).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(STREAM_REPAINT_INTERVAL_MS * 2);
		expect(render).toHaveBeenCalledTimes(2);
		throttle.dispose();
	});

	test("flush does nothing without a pending render", () => {
		const render = vi.fn();
		const throttle = createRenderThrottle(render);
		throttle.flush();
		expect(render).not.toHaveBeenCalled();
		throttle.request();
		expect(render).toHaveBeenCalledTimes(1);
		throttle.flush();
		expect(render).toHaveBeenCalledTimes(1);
		throttle.dispose();
	});

	test("flush after dispose is inert", () => {
		const render = vi.fn();
		const throttle = createRenderThrottle(render);
		throttle.request();
		throttle.request();
		throttle.dispose();
		throttle.flush();
		expect(render).toHaveBeenCalledTimes(1);
	});

	test("dispose is idempotent", () => {
		const throttle = createRenderThrottle(() => undefined);
		throttle.dispose();
		expect(() => throttle.dispose()).not.toThrow();
	});

	test("rejects an interval that cannot be a window", () => {
		expect(() => createRenderThrottle(() => undefined, 0)).toThrow(/positive safe integer/);
		expect(() => createRenderThrottle(() => undefined, -1)).toThrow(/positive safe integer/);
		expect(() => createRenderThrottle(() => undefined, 1.5)).toThrow(/positive safe integer/);
	});
});
