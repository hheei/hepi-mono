import { expect } from "bun:test";
import type {
	HepiContext,
	HepiSettingsProvider,
	HepiSettingsState,
	HepiSettingsStorage,
} from "../src/core/api/settings.js";
import { visibleWidth } from "../src/core/ui/text.js";

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
	initial?: HepiSettingsState;
	delayMs?: number;
	failLoad?: unknown;
	failSave?: unknown;
}

export function fakeStorage(options: FakeStorageOptions = {}): HepiSettingsStorage & {
	state: HepiSettingsState | undefined;
	saves: HepiSettingsState[];
} {
	const storage = {
		state: options.initial,
		saves: [] as HepiSettingsState[],
		async load(_ctx: HepiContext) {
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			if (options.failLoad !== undefined) throw options.failLoad;
			return storage.state;
		},
		async save(state: HepiSettingsState, _ctx: HepiContext) {
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			if (options.failSave !== undefined) throw options.failSave;
			storage.state = state;
			storage.saves.push(state);
		},
	};
	return storage;
}

export function testContext(overrides: Partial<HepiContext> = {}): HepiContext {
	return { sessionId: "test-session", cwd: "/tmp/pi-basics", ...overrides };
}

export function fakeProvider(overrides: Partial<HepiSettingsProvider> = {}): HepiSettingsProvider {
	return { id: "fake", title: "Fake Provider", groups: [], storage: fakeStorage(), ...overrides };
}
