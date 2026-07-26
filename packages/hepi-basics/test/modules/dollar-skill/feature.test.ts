import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
	createDollarSkillFeature,
	registerDollarSkillInputTransform,
} from "../../../src/dollar-skill/index.js";
import type { DollarSkillCommand } from "../../../src/dollar-skill/model.js";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;

type InputHandler = (event: {
	text: string;
	images?: unknown[];
	source: "interactive" | "rpc" | "extension";
}) => unknown;

function harness(
	mode: "tui" | "json",
	commands: readonly DollarSkillCommand[] = [
		{
			name: "skill:librarian",
			source: "skill",
			sourceInfo: { path: "/skills/librarian/SKILL.md", scope: "user" },
		},
	],
) {
	let inputHandler: InputHandler | undefined;
	let wrapper: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
	let editorFactory: EditorFactory | undefined;
	const pi = {
		on(event: string, handler: InputHandler) {
			if (event === "input") inputHandler = handler;
		},
		getCommands: () => commands,
	} as unknown as ExtensionAPI;
	const ctx = {
		mode,
		ui: {
			addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
				wrapper = factory;
			},
			getEditorComponent: () => editorFactory,
			setEditorComponent: (factory: EditorFactory | undefined) => {
				editorFactory = factory;
			},
		},
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	return {
		pi,
		ctx,
		get inputHandler() {
			return inputHandler;
		},
		get wrapper() {
			return wrapper;
		},
		get editorFactory() {
			return editorFactory;
		},
	};
}

describe("dollar skill feature", () => {
	test("installs TUI autocomplete and scopes transforms to the active session", () => {
		const host = harness("tui");
		const feature = createDollarSkillFeature(host.pi);
		registerDollarSkillInputTransform(host.pi, feature);
		expect(host.inputHandler?.({ text: "$librarian", source: "interactive" })).toBeUndefined();
		feature.start({ pi: host.pi, ctx: host.ctx } as never);
		expect(host.wrapper).toBeDefined();
		expect(host.editorFactory).toBeDefined();
		expect(host.inputHandler?.({ text: "Use $librarian.", source: "interactive" })).toEqual({
			action: "transform",
			text: "Use /skills/librarian/SKILL.md.",
		});
		expect(host.inputHandler?.({ text: "$librarian", source: "extension" })).toBeUndefined();
		feature.dispose("session-1");
		expect(host.editorFactory).toBeUndefined();
		expect(host.inputHandler?.({ text: "$librarian", source: "interactive" })).toBeUndefined();
	});

	test("forwards live skill status to autocomplete", async () => {
		const host = harness("tui");
		const feature = createDollarSkillFeature(host.pi, () => false);
		feature.start({ pi: host.pi, ctx: host.ctx } as never);
		const current: AutocompleteProvider = {
			async getSuggestions() {
				return null;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		};
		const provider = host.wrapper?.(current);

		expect(
			await provider?.getSuggestions(["$lib"], 0, 4, {
				signal: new AbortController().signal,
			}),
		).toEqual({
			prefix: "$lib",
			items: [
				{
					value: "$librarian",
					label: "\x1b[2mlibrarian\x1b[22m",
					description: "\x1b[2mUser\x1b[22m",
				},
			],
		});
	});

	test("uses the enabled project path for duplicate skill names", () => {
		const host = harness("tui", [
			{
				name: "skill:review",
				source: "skill",
				sourceInfo: { path: "/user/review/SKILL.md", scope: "user" },
			},
			{
				name: "skill:review",
				source: "skill",
				sourceInfo: { path: "/project/.pi/skills/review/SKILL.md", scope: "project" },
			},
		]);
		const feature = createDollarSkillFeature(
			host.pi,
			(command) => command.sourceInfo?.scope === "project",
		);
		registerDollarSkillInputTransform(host.pi, feature);
		feature.start({ pi: host.pi, ctx: host.ctx } as never);

		expect(host.inputHandler?.({ text: "Use $review.", source: "interactive" })).toEqual({
			action: "transform",
			text: "Use /project/.pi/skills/review/SKILL.md.",
		});
	});

	test("keeps input expansion but skips autocomplete outside TUI", () => {
		const host = harness("json");
		const feature = createDollarSkillFeature(host.pi);
		registerDollarSkillInputTransform(host.pi, feature);
		feature.start({ pi: host.pi, ctx: host.ctx } as never);
		expect(host.wrapper).toBeUndefined();
		expect(host.editorFactory).toBeUndefined();
		const images = [{ type: "image", data: "fixture", mimeType: "image/png" }];
		expect(host.inputHandler?.({ text: "$librarian", images, source: "rpc" })).toEqual({
			action: "transform",
			text: "/skills/librarian/SKILL.md",
			images,
		});
		feature.setConfig({ enabled: false, maxSuggestions: 20 });
		expect(host.inputHandler?.({ text: "$librarian", source: "interactive" })).toBeUndefined();
	});
});
