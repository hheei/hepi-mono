import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import { buildConfigEditingTabs } from "../extensions/config/config-editing-model.js";
import {
	buildRetainReceiptStatusFacts,
	createHindsightHubComponent,
	createSetupComponent,
	runHindsightSetupTui,
} from "../extensions/tui/setup-tui.js";
import { HUB_ACTION_HELP } from "../extensions/tui/setup-tui-types.js";

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const receipt = {
	createdAt: "2026-05-02T00:00:00.000Z",
	bankId: "global-luxus",
	documentId: "pi-explicit:session123:abcdef1234567890",
	queueJobId: "job-1",
	updateMode: "replace" as const,
	source: "tool" as const,
	context: "context",
	tags: ["preference"],
};

describe("setup TUI receipt facts", () => {
	it("shows recent exact retain document IDs without raw content", () => {
		expect(buildRetainReceiptStatusFacts([receipt])).toEqual([
			["Recent retain", "global-luxus pi-explicit:abcdef1234567890"],
		]);
	});

	it("renders a compact narrow-safe hub without advanced settings", () => {
		const actions: Array<string | null> = [];
		const component = createHindsightHubComponent(
			[
				["Status", "connected"],
				["Bank", "coding"],
				["Queue", "0"],
				["Ignored", "not shown"],
			],
			theme,
			(action) => actions.push(action),
		);

		for (const width of [48, 100]) {
			const rendered = component.render(width);
			expect(rendered).toHaveLength(10);
			expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(rendered.join("\n")).not.toContain("advanced");
		}
		component.handleInput?.("f");
		expect(actions).toEqual(["flush-queue"]);
	});

	it("shows empty receipt state", () => {
		expect(buildRetainReceiptStatusFacts([])).toEqual([["Retain receipts", "none"]]);
	});

	it("renders selected field detail text", () => {
		const tabs = buildConfigEditingTabs(
			DEFAULT_CONFIG,
			"bank",
			{ project: {}, global: {}, env: {} },
			[],
			{ showAdvanced: true },
		);
		// Banks field order: memoryProfile, agentUse, mentalModelsInject, projectBankId, globalBankEnabled, ...
		const component = createSetupComponent(
			tabs,
			theme,
			{ tabIndex: 2, selectedByTab: { Banks: 4 }, showAdvanced: true },
			() => undefined,
		);

		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("Docs: https://luxus.github.io/pi-hindsight/concepts/memory-banks/");
		expect(rendered).toContain("Allows cross-project recall");
		// Footer is width-truncated; assert the full hub help string and visible prefix.
		expect(HUB_ACTION_HELP).toContain("f flush");
		expect(HUB_ACTION_HELP).toContain("t templates");
		expect(HUB_ACTION_HELP.indexOf("f flush")).toBeLessThan(HUB_ACTION_HELP.indexOf("t templates"));
		expect(rendered).toContain("g guided");
		expect(rendered).toContain("m mode");
		expect(rendered).toContain("x next-opt-out");
	});

	it("default hub shows Status only until advanced is enabled", () => {
		const basic = buildConfigEditingTabs(DEFAULT_CONFIG, "bank", {
			project: {},
			global: {},
			env: {},
		});
		expect(basic.map((tab) => tab.id)).toEqual(["Status"]);
		const advanced = buildConfigEditingTabs(
			DEFAULT_CONFIG,
			"bank",
			{ project: {}, global: {}, env: {} },
			[],
			{ showAdvanced: true },
		);
		expect(advanced.map((tab) => tab.id)).toContain("Banks");
	});

	it("opens the hub through the ext-core surface and closes it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-surface-"));
		const controller = new AbortController();
		let customCalls = 0;
		let customOptions: unknown;
		const ctx = {
			cwd,
			mode: "tui",
			sessionManager: { getSessionFile: () => undefined },
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				custom: <T>(
					factory: (
						tui: { requestRender(): void },
						colors: typeof theme,
						keybindings: unknown,
						done: (value: T) => void,
					) => { handleInput?(input: string): void },
					options?: unknown,
				): Promise<T> => {
					customCalls++;
					customOptions = options;
					return new Promise((resolve) => {
						const component = factory({ requestRender: () => undefined }, theme, {}, resolve);
						component.handleInput?.("q");
					});
				},
			},
		};
		const pi = { events: {} };
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ "pi-hindsight": { setupComplete: true } }),
		);

		await runHindsightSetupTui(
			ctx as never,
			{
				getClient: () => ({ retain: vi.fn(), recall: vi.fn(), reflect: vi.fn() }),
				getConfig: () => DEFAULT_CONFIG,
				getProjectBankId: () => "project-bank",
			} as never,
			{ pi: pi as never, signal: controller.signal },
		);

		expect(customCalls).toBe(1);
		expect(customOptions).toMatchObject({
			overlay: true,
			overlayOptions: { width: 78, maxHeight: "80%", anchor: "center", margin: 1 },
		});
	});

	it("writes durable ignore-repo config from no-config prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-ignore-repo-"));
		const notify = vi.fn();
		const ctx = {
			cwd,
			sessionManager: { getSessionFile: () => undefined },
			ui: {
				notify,
				select: vi.fn().mockResolvedValueOnce("Ignore this repo"),
				confirm: vi.fn().mockResolvedValueOnce(true),
				custom: vi.fn(),
				input: vi.fn(),
			},
		} as never;

		await runHindsightSetupTui(ctx, {
			getClient: () => ({
				retain: vi.fn(),
				recall: vi.fn(),
				reflect: vi.fn(),
			}),
			getConfig: () => DEFAULT_CONFIG,
			getProjectBankId: () => "project-bank",
		} as never);

		const written = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")) as {
			"pi-hindsight": {
				enabled: boolean;
				setupComplete: boolean;
				status?: { style?: string };
			};
		};
		expect(written["pi-hindsight"].enabled).toBe(false);
		expect(written["pi-hindsight"].setupComplete).toBe(true);
		expect(written["pi-hindsight"].status?.style).toBe("off");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Hindsight disabled for this repo"),
			"info",
		);
	});

	it("does not write ignore-repo config when confirm is declined", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-ignore-decline-"));
		const ctx = {
			cwd,
			sessionManager: { getSessionFile: () => undefined },
			ui: {
				notify: vi.fn(),
				select: vi.fn().mockResolvedValueOnce("Ignore this repo"),
				confirm: vi.fn().mockResolvedValueOnce(false),
				custom: vi.fn(),
				input: vi.fn(),
			},
		} as never;

		await runHindsightSetupTui(ctx, {
			getClient: () => ({
				retain: vi.fn(),
				recall: vi.fn(),
				reflect: vi.fn(),
			}),
			getConfig: () => DEFAULT_CONFIG,
			getProjectBankId: () => "project-bank",
		} as never);

		expect(() => readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).toThrow();
	});
});
