import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
	createResponseStatusFeature,
	formatCompactNumber,
	formatDurationColor,
	formatRate,
	formatTelemetryStatus,
	TELEMETRY_DISMISS_DELAY_MS,
} from "../src/index.js";

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

const mockTheme = {
	fg(
		color: "dim" | "muted" | "success" | "warning" | "error" | "accent" | "text",
		text: string,
	): string {
		return `[${color}:${text}]`;
	},
};

function harness(id = "session", mode: ExtensionContext["mode"] = "tui") {
	let sessionId = id;
	const handlers = new Map<string, EventHandler[]>();

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			theme: mockTheme,
		},
	} as unknown as ExtensionContext;

	return {
		pi,
		ctx,
		setSessionId(next: string) {
			sessionId = next;
		},
		emit(event: string, value: unknown, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) handler(value as never, eventCtx);
		},
	};
}

function assistant(input: number, output: number, cacheRead = 0, stopReason = "stop") {
	return {
		role: "assistant" as const,
		usage: { input, output, cacheRead, totalTokens: input + output + cacheRead },
		stopReason,
	};
}

describe("response telemetry formatters", () => {
	test("formats compact token numbers", () => {
		expect(formatCompactNumber(0)).toBe("0");
		expect(formatCompactNumber(999)).toBe("999");
		expect(formatCompactNumber(1_000)).toBe("1K");
		expect(formatCompactNumber(1_200)).toBe("1.2K");
		expect(formatCompactNumber(1_250)).toBe("1.3K");
		expect(formatCompactNumber(999_999)).toBe("1000K");
		expect(formatCompactNumber(1_000_000)).toBe("1M");
		expect(formatCompactNumber(2_500_000)).toBe("2.5M");
		expect(formatCompactNumber(Number.NaN)).toBe("?");
	});

	test("formats rate with 1 decimal place", () => {
		expect(formatRate(null)).toBe("?");
		expect(formatRate(Number.NaN)).toBe("?");
		expect(formatRate(-1)).toBe("?");
		expect(formatRate(0)).toBe("0.0");
		expect(formatRate(95.123)).toBe("95.1");
		expect(formatRate(120)).toBe("120.0");
	});

	test("formats duration with semantic color", () => {
		expect(formatDurationColor(null, mockTheme)).toBe("[dim:󰔛?]");
		expect(formatDurationColor(3_200, mockTheme)).toBe("[success:󰔛3.2s]");
		expect(formatDurationColor(9_700, mockTheme)).toBe("[warning:󰔛9.7s]");
		expect(formatDurationColor(15_000, mockTheme)).toBe("[error:󰔛15.0s]");
		expect(formatDurationColor(20_000, mockTheme)).toBe("[error:󰔛20.0s]");
	});

	test("formats full telemetry with theme colors", () => {
		const metrics = {
			input: 5_300,
			output: 924,
			cacheRead: 62_500,
			durationMs: 9_700,
			tokensPerSecond: 95.1,
		};
		const status = formatTelemetryStatus(metrics, mockTheme);
		expect(status).toBe("[dim:↑5.3K ↓924 ⇲62.5K] [warning:󰔛9.7s] [dim:󰓅95.1/s]");
	});

	test("formats full telemetry with ColorFn", () => {
		const metrics = {
			input: 5_300,
			output: 924,
			cacheRead: 62_500,
			durationMs: 9_700,
			tokensPerSecond: 95.1,
		};
		const colorFn = (text: string) => `[border:${text}]`;
		const status = formatTelemetryStatus(metrics, colorFn);
		expect(status).toBe("[border:↑5.3K ↓924 ⇲62.5K 󰔛9.7s 󰓅95.1/s]");
	});
});

describe("response status lifecycle", () => {
	test("keeps the last completed usage until the next response replaces it", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const feature = createResponseStatusFeature(h.pi);
			feature.start(h.ctx);
			const updates = vi.fn();
			feature.onUpdate(updates);

			// No status while a request is in progress
			vi.setSystemTime(1_000);
			h.emit("agent_start", {});
			h.emit("turn_start", { timestamp: 1_000 });
			expect(feature.getStatus(mockTheme)).toBeUndefined();
			expect(updates).not.toHaveBeenCalled();

			// message_end: telemetry becomes available
			vi.setSystemTime(8_100);
			h.emit("message_end", { message: assistant(654, 213, 83_000) });

			expect(updates).toHaveBeenCalledTimes(1);
			const status = feature.getStatus(mockTheme);
			expect(status).toContain("↑654 ↓213 ⇲83K");
			expect(status).toContain("󰔛7.1s");
			expect(status).toContain("󰓅30.0/s");

			// A new request starts: previous telemetry stays visible while it runs
			vi.setSystemTime(10_000);
			h.emit("agent_start", {});
			h.emit("turn_start", { timestamp: 10_000 });
			await vi.advanceTimersByTimeAsync(60_000);
			expect(feature.getStatus(mockTheme)).toContain("↑654 ↓213 ⇲83K");

			// Tool-use assistant response replaces previous line
			vi.setSystemTime(70_000);
			h.emit("message_end", { message: assistant(7, 3, 0, "toolUse") });
			expect(feature.getStatus(mockTheme)).toContain("↑7 ↓3 ⇲0");

			// The run ends: visible telemetry is dismissed after delay
			vi.setSystemTime(70_100);
			h.emit("agent_end", {});
			await vi.advanceTimersByTimeAsync(TELEMETRY_DISMISS_DELAY_MS - 1);
			expect(feature.getStatus(mockTheme)).toContain("↑7 ↓3 ⇲0");
			await vi.advanceTimersByTimeAsync(1);
			expect(feature.getStatus(mockTheme)).toBeUndefined();

			feature.dispose("session");
		} finally {
			vi.useRealTimers();
		}
	});

	test("does not dismiss telemetry while a long run is still in progress", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const feature = createResponseStatusFeature(h.pi);
			feature.start(h.ctx);

			// A tool-use message completes, then its tool call runs far longer than delay
			vi.setSystemTime(1_000);
			h.emit("agent_start", {});
			h.emit("turn_start", { timestamp: 1_000 });
			vi.setSystemTime(2_000);
			h.emit("message_end", { message: assistant(10, 5, 0, "toolUse") });
			await vi.advanceTimersByTimeAsync(TELEMETRY_DISMISS_DELAY_MS * 4);
			expect(feature.getStatus(mockTheme)).toContain("↑10 ↓5 ⇲0");

			feature.dispose("session");
		} finally {
			vi.useRealTimers();
		}
	});

	test("clears metrics immediately when response errors or aborts", () => {
		const h = harness();
		const feature = createResponseStatusFeature(h.pi);
		feature.start(h.ctx);

		h.emit("turn_start", { timestamp: 1_000 });
		h.emit("message_end", { message: assistant(100, 50, 0, "error") });
		expect(feature.getStatus(mockTheme)).toBeUndefined();

		h.emit("turn_start", { timestamp: 2_000 });
		h.emit("message_end", { message: assistant(100, 50, 0, "aborted") });
		expect(feature.getStatus(mockTheme)).toBeUndefined();

		feature.dispose("session");
	});
});
