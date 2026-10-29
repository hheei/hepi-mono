import {
	type ExtensionContext,
	type ExtensionUIContext,
	InteractiveMode,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { installHostToolGroups } from "../src/host-transcript-patch.js";

const cleanups: (() => void)[] = [];
beforeAll(() => initTheme("dark", false));
afterEach(() => {
	for (const dispose of cleanups.splice(0).reverse()) dispose();
	vi.restoreAllMocks();
});

function setup() {
	const host: object = Object.create(InteractiveMode.prototype);
	const ui: ExtensionUIContext = Reflect.apply(
		Reflect.get(host, "createExtensionUIContext"),
		host,
		[],
	);
	Object.assign(ui, { getToolsExpanded: () => false, notify: vi.fn() });
	const chat = new Container();
	Object.defineProperties(host, {
		chatContainer: { value: chat },
		ui: { value: { requestRender: vi.fn() } },
		session: { value: { extensionRunner: { getUIContext: () => ui } } },
	});
	// This private patch consumes only the native UI facade from ExtensionContext.
	const patch = installHostToolGroups({ ui } as ExtensionContext);
	cleanups.push(patch.dispose);
	const notice = () =>
		Reflect.apply(Reflect.get(host, "showExtensionNotify"), host, ["notice", "info"]);
	const notices = () => {
		for (let i = 0; i < 4; i += 1) notice();
	};
	const show = () => stripTerminalSequences(chat.render(80).join("\n"));
	return { chat, patch, notice, notices, show };
}

test("history not rendered before agent_start retains an unknown clock", () => {
	const now = vi.spyOn(performance, "now").mockReturnValue(0);
	const f = setup();
	f.notices();
	now.mockReturnValue(1_000);
	f.patch.beginRun();
	now.mockReturnValue(2_000);
	expect(f.show()).toContain("collapse views · — · 0 calls");
	now.mockReturnValue(9_000);
	expect(f.show()).toContain("collapse views · — · 0 calls");
});

test("live content joining unrendered history starts its own observed clock", () => {
	const now = vi.spyOn(performance, "now").mockReturnValue(0);
	const f = setup();
	f.notices();
	f.patch.beginRun();
	expect(f.show()).toContain("collapse views · — · 0 calls");
	now.mockReturnValue(3_000);
	f.notice();
	expect(f.show()).toContain("collapse views · 0s · 0 calls");
	now.mockReturnValue(8_000);
	f.patch.endRun();
	expect(f.show()).toContain("collapse views · 5s · 0 calls");
	now.mockReturnValue(12_000);
	expect(f.show()).toContain("collapse views · 5s · 0 calls");
});

test("unpainted history and a new live block keep separate clocks", () => {
	const now = vi.spyOn(performance, "now").mockReturnValue(0);
	const f = setup();
	f.notices();
	f.patch.beginRun();
	f.chat.addChild(new Text("boundary", 0, 0));
	f.notices();
	now.mockReturnValue(2_000);
	expect(f.show()).toContain("collapse views · — · 0 calls");
	expect(f.show()).toContain("collapse views · 0s · 0 calls");
	now.mockReturnValue(7_000);
	f.patch.endRun();
	expect(f.show()).toContain("collapse views · 5s · 0 calls");
	expect(f.show()).toContain("collapse views · — · 0 calls");
});
