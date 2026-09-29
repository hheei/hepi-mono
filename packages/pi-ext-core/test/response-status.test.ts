import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Editor, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	createResponseStatusFeature,
	formatCompactNumber,
	formatDurationColor,
	formatRate,
	formatTelemetryStatus,
	renderBottomRailBorder,
	TELEMETRY_DISMISS_DELAY_MS,
	wrapEditorBottomRail,
} from "../src/index.js";

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;
type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;

class MockEditor implements EditorComponent {
	#text = "";
	getText(): string {
		return this.#text;
	}
	setText(text: string): void {
		this.#text = text;
	}
	invalidate(): void {}
	renderBottomBorder(width: number, hiddenLineCount: number): string {
		return hiddenLineCount > 0 ? `── ↓ ${hiddenLineCount} more ──` : "─".repeat(width);
	}
	borderColor(text: string): string {
		return `[b:${text}]`;
	}
	render(width: number): string[] {
		return [this.renderBottomBorder(width, 0)];
	}
	handleInput(_data: string): void {}
}

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
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	let editorFactory: EditorFactory | undefined;
	const requestRender = vi.fn();
	const tui = { requestRender } as unknown as TUI;

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			getEditorComponent() {
				return editorFactory;
			},
			setEditorComponent(factory: EditorFactory | undefined) {
				editorFactory = factory;
			},
			theme: mockTheme,
		},
	} as unknown as ExtensionContext;

	return {
		pi,
		ctx,
		tui,
		requestRender,
		notifications,
		get editorFactory() {
			return editorFactory;
		},
		setSessionId(next: string) {
			sessionId = next;
		},
		emit(event: string, value: unknown, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) handler(value as never, eventCtx);
		},
	};
}

function assistant(
	input: number,
	output: number,
	cacheRead: number,
	stopReason = "stop",
): Record<string, unknown> {
	return { role: "assistant", usage: { input, output, cacheRead }, stopReason };
}

describe("response status", () => {
	test("formats compact numbers, rates, and duration semantic colors", () => {
		expect(formatCompactNumber(0)).toBe("0");
		expect(formatCompactNumber(924)).toBe("924");
		expect(formatCompactNumber(5_300)).toBe("5.3K");
		expect(formatCompactNumber(62_500)).toBe("62.5K");
		expect(formatCompactNumber(1_200_000)).toBe("1.2M");

		expect(formatRate(null)).toBe("?");
		expect(formatRate(95.123)).toBe("95.1");

		// < 5s is success (green)
		expect(formatDurationColor(3_200, mockTheme)).toBe("[success:󰔛3.2s]");
		// 5s ~ 15s is warning (yellow)
		expect(formatDurationColor(9_700, mockTheme)).toBe("[warning:󰔛9.7s]");
		// >= 15s is error (red)
		expect(formatDurationColor(16_000, mockTheme)).toBe("[error:󰔛16.0s]");
	});

	test("formats full telemetry line matching expected glyphs and layout", () => {
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

	test("formats full telemetry with ColorFn following bottom rail border color", () => {
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

	test("keeps the last completed usage until the next response replaces it", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const originalFactory: EditorFactory = () => new MockEditor();
			h.ctx.ui.setEditorComponent(originalFactory);

			const feature = createResponseStatusFeature(h.pi);
			feature.start(h.ctx);

			expect(h.editorFactory).toBeDefined();
			const editor = h.editorFactory?.(
				h.tui,
				mockTheme as unknown as EditorTheme,
				{} as KeybindingsManager,
			);
			expect(editor).toBeDefined();

			const mockEd = editor as unknown as MockEditor;

			// No status is shown while a request is in progress.
			vi.setSystemTime(1_000);
			h.emit("agent_start", {});
			h.emit("turn_start", { timestamp: 1_000 });
			expect(mockEd.renderBottomBorder(80, 0)).toBe("─".repeat(80));
			h.requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(600);
			expect(h.requestRender).not.toHaveBeenCalled();

			// message_end: telemetry appears using mockEd.borderColor.
			vi.setSystemTime(8_100);
			h.emit("message_end", { message: assistant(654, 213, 83_000) });

			// Verify ctx.ui.notify was NOT called (no noisy turn notifications)
			expect(h.notifications).toEqual([]);

			// Verify the editor bottom rail now displays the response telemetry with borderColor [b:...]
			const bottomBorder = mockEd.renderBottomBorder(80, 0);
			expect(bottomBorder).toContain("[b:↑654 ↓213 ⇲83K 󰔛7.1s 󰓅30.0/s]");

			// A new request starts: the previous telemetry must stay visible while it runs.
			vi.setSystemTime(10_000);
			h.emit("agent_start", {});
			h.emit("turn_start", { timestamp: 10_000 });
			await vi.advanceTimersByTimeAsync(60_000);
			expect(mockEd.renderBottomBorder(80, 0)).toContain("[b:↑654 ↓213 ⇲83K");

			// Tool-use assistant responses are complete responses too, even when the
			// provider uses a non-final stop reason, and they replace the previous line.
			vi.setSystemTime(70_000);
			h.emit("message_end", { message: assistant(7, 3, 0, "toolUse") });
			expect(mockEd.renderBottomBorder(80, 0)).toContain("[b:↑7 ↓3 ⇲0");

			// The run ends: the visible line is dismissed after the delay, not before.
			vi.setSystemTime(70_100);
			h.emit("agent_end", {});
			await vi.advanceTimersByTimeAsync(TELEMETRY_DISMISS_DELAY_MS - 1);
			expect(mockEd.renderBottomBorder(80, 0)).toContain("[b:↑7 ↓3 ⇲0");
			await vi.advanceTimersByTimeAsync(1);
			expect(mockEd.renderBottomBorder(80, 0)).toBe("─".repeat(80));

			feature.dispose("session");
		} finally {
			vi.useRealTimers();
		}
	});

	test("does not dismiss the visible line while a long run is still in progress", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			h.ctx.ui.setEditorComponent(() => new MockEditor());
			const feature = createResponseStatusFeature(h.pi);
			feature.start(h.ctx);
			const mockEd = h.editorFactory?.(
				h.tui,
				mockTheme as unknown as EditorTheme,
				{} as KeybindingsManager,
			) as unknown as MockEditor;

			// A tool-use message completes, then its tool call runs far longer than the delay.
			vi.setSystemTime(1_000);
			h.emit("agent_start", {});
			h.emit("turn_start", { timestamp: 1_000 });
			vi.setSystemTime(2_000);
			h.emit("message_end", { message: assistant(10, 5, 0, "toolUse") });
			await vi.advanceTimersByTimeAsync(TELEMETRY_DISMISS_DELAY_MS * 4);
			expect(mockEd.renderBottomBorder(80, 0)).toContain("[b:↑10 ↓5 ⇲0");

			feature.dispose("session");
		} finally {
			vi.useRealTimers();
		}
	});

	test("renders scroll indicator on bottom rail when content overflows below", () => {
		const status = "[dim:↑5.3K ↓924 ⇲62.5K] [success:󰔛3.2s] [dim:󰓅95.1/s]";
		const border = renderBottomRailBorder({
			width: 80,
			hiddenLineCount: 4,
			statusText: status,
			borderColor: (t) => `|${t}|`,
			fallback: () => "fallback",
		});
		expect(border).toContain("↓ 4 more");
		expect(border).toContain(status);
	});

	test("wraps editor and injects status via custom renderBottomBorder", () => {
		const base = new MockEditor();
		const wrapped = wrapEditorBottomRail(base, () => "TEST_STATUS");
		const target = wrapped as unknown as MockEditor;
		expect(target.renderBottomBorder(40, 0)).toContain("TEST_STATUS");
	});

	// Uses the real pi-tui editor and main screen: the host's CustomEditor only
	// overrides renderTopBorder, so its bottom border is this same Editor method.
	test("shows telemetry on the real editor bottom border through the real main screen", async () => {
		const terminal = {
			columns: 80,
			rows: 12,
			kittyProtocolActive: false,
			start: vi.fn(),
			stop: vi.fn(),
			drainInput: vi.fn(async () => {}),
			write: vi.fn(),
			moveBy: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
			clearLine: vi.fn(),
			clearFromCursor: vi.fn(),
			clearScreen: vi.fn(),
			setTitle: vi.fn(),
			setProgress: vi.fn(),
		} satisfies Terminal;
		const screen = new TuiMainScreen(terminal);

		const h = harness();
		h.ctx.ui.setEditorComponent(
			(tui, _theme, _keybindings) =>
				new Editor(tui, {
					borderColor: (text) => text,
					selectList: {} as never,
				}),
		);
		const feature = createResponseStatusFeature(h.pi);
		feature.start(h.ctx);

		const editor = h.editorFactory?.(screen, undefined as never, undefined as never);
		if (editor === undefined) throw new Error("Expected the response status editor");
		screen.addChild(editor);
		screen.renderNow();

		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			h.emit("agent_start", {});
			h.emit("turn_start", { timestamp: 1_000 });
			vi.setSystemTime(8_100);
			h.emit("message_end", { message: assistant(654, 213, 83_000) });
			await vi.advanceTimersByTimeAsync(1_000);
		} finally {
			vi.useRealTimers();
		}

		const output = terminal.write.mock.calls.map(([data]) => data).join("");
		expect(output).toContain("↑654 ↓213 ⇲83K");
		expect(output).toContain("󰔛7.1s");
		expect(output).toContain("󰓅30.0/s");
		feature.dispose("session");
	});
});
