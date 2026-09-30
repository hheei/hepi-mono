import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CustomEditorLike,
	EditorWorkingStatusIndicator,
	registerActiveEditor,
	setPreTurnWorkingStatus,
	type TuiLike,
	unregisterActiveEditor,
} from "../src/index.js";

describe("editor-working-status", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("EditorWorkingStatusIndicator renders spinner and message in border", () => {
		const tui: TuiLike = { requestRender: vi.fn() };
		const indicator = new EditorWorkingStatusIndicator(
			tui,
			"Recalling",
			(s) => `[spin:${s}]`,
			(m) => `[msg:${m}]`,
		);

		const rendered = indicator.renderInBorder(50);
		expect(rendered).toBe("[spin:⠋] [msg:Recalling]");

		const spinnerOnly = indicator.renderSpinnerInBorder(20);
		expect(spinnerOnly).toBe("[spin:⠋]");

		// Advance timer to verify animation
		vi.advanceTimersByTime(80);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
		expect(indicator.renderInBorder(50)).toBe("[spin:⠙] [msg:Recalling]");

		vi.advanceTimersByTime(80);
		expect(indicator.renderInBorder(50)).toBe("[spin:⠹] [msg:Recalling]");

		indicator.dispose();
	});

	test("setPreTurnWorkingStatus safely does nothing when no editor is registered", () => {
		const cleanup = setPreTurnWorkingStatus("Recalling");
		expect(typeof cleanup).toBe("function");
		cleanup();
	});

	test("setPreTurnWorkingStatus mounts and unmounts indicator on registered editor", () => {
		const tui: TuiLike = { requestRender: vi.fn() };
		let currentIndicator: unknown;
		const editor: CustomEditorLike = {
			setWorkingStatusIndicator(ind) {
				currentIndicator = ind;
				this.workingStatusIndicator = ind;
			},
			workingStatusIndicator: undefined,
		};

		registerActiveEditor(editor, tui);

		const cleanup = setPreTurnWorkingStatus("Recalling");
		expect(currentIndicator).toBeDefined();
		expect(editor.workingStatusIndicator).toBe(currentIndicator);
		expect(tui.requestRender).toHaveBeenCalled();

		cleanup();
		expect(editor.workingStatusIndicator).toBeUndefined();

		unregisterActiveEditor(editor);
	});

	test("cleanup does not clear indicator if host has already replaced it", () => {
		const tui: TuiLike = { requestRender: vi.fn() };
		const editor: CustomEditorLike = {
			setWorkingStatusIndicator(ind) {
				this.workingStatusIndicator = ind;
			},
			workingStatusIndicator: undefined,
		};

		registerActiveEditor(editor, tui);

		const cleanup = setPreTurnWorkingStatus("Recalling");
		expect(editor.workingStatusIndicator).toBeDefined();

		// Simulate host (Pi) agent_start taking over with native Working indicator
		const hostIndicator = { renderInBorder: () => "Working" };
		editor.setWorkingStatusIndicator?.(hostIndicator);

		// Now our cleanup runs after recall resolves
		cleanup();
		// Host indicator must stay intact
		expect(editor.workingStatusIndicator).toBe(hostIndicator);

		unregisterActiveEditor(editor);
	});
});
