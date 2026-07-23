import { expect } from "bun:test";
import type {
	HePiContext,
	HePiSettingsProvider,
	HePiSettingsState,
	HePiSettingsStorage,
} from "../src/api/settings.js";
import { visibleWidth } from "../src/ui/text.js";

export function stripAnsi(text: string): string {
	return text.replace(/\p{Cc}\[[0-?]*[ -/]*[@-~]/gu, (sequence) => {
		const control = sequence.codePointAt(0);
		return control === 0x1b || control === 0x9b ? "" : sequence;
	});
}

export function fakeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
	};
}

export function renderText(
	component: { render(width: number): string[] },
	width: number,
): string[] {
	return component.render(width);
}

export function assertVisibleWidth(lines: readonly string[], width: number): void {
	for (const line of lines) expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
}

export interface FakeHost {
	notifications: Array<{ message: string; level?: string }>;
	renderRequests: number;
	notify(message: string, level?: string): void;
	requestRender(): void;
}

export function fakeHost(): FakeHost {
	const host: FakeHost = {
		notifications: [],
		renderRequests: 0,
		notify(message, level) {
			host.notifications.push(level === undefined ? { message } : { message, level });
		},
		requestRender() {
			host.renderRequests++;
		},
	};
	return host;
}

export interface FakeStorageOptions {
	initial?: HePiSettingsState;
	delayMs?: number;
	failLoad?: unknown;
	failSave?: unknown;
}

export function fakeStorage(options: FakeStorageOptions = {}): HePiSettingsStorage & {
	state: HePiSettingsState | undefined;
	saves: HePiSettingsState[];
} {
	const storage = {
		state: options.initial,
		saves: [] as HePiSettingsState[],
		async load(_ctx: HePiContext) {
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			if (options.failLoad !== undefined) throw options.failLoad;
			return storage.state;
		},
		async save(state: HePiSettingsState, _ctx: HePiContext) {
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			if (options.failSave !== undefined) throw options.failSave;
			storage.state = state;
			storage.saves.push(state);
		},
	};
	return storage;
}

export function testContext(overrides: Partial<HePiContext> = {}): HePiContext {
	return { sessionId: "test-session", cwd: "/tmp/pi-basics", ...overrides };
}

export function fakeProvider(overrides: Partial<HePiSettingsProvider> = {}): HePiSettingsProvider {
	return { id: "fake", title: "Fake Provider", groups: [], storage: fakeStorage(), ...overrides };
}
