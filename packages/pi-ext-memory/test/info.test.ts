import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createMemoryInfo } from "../src/info.js";

type Renderer = Parameters<ExtensionAPI["registerEntryRenderer"]>[1];
type Entry = Parameters<Renderer>[0];
type Theme = Parameters<Renderer>[2];

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

function host(): {
	readonly info: ReturnType<typeof createMemoryInfo>;
	readonly entries: Array<{ readonly type: string; readonly data: unknown }>;
	readonly renderer: Renderer;
} {
	const entries: Array<{ readonly type: string; readonly data: unknown }> = [];
	let renderer: Renderer | undefined;
	const pi = {
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		registerEntryRenderer: (_type: string, value: Renderer) => {
			renderer = value;
		},
	} as unknown as ExtensionAPI;
	const info = createMemoryInfo(pi);
	if (renderer === undefined) throw new Error("memory entry renderer missing");
	return { info, entries, renderer };
}

function entry(data: unknown): Entry {
	return { data } as Entry;
}

test("reports an injected memory as a resumable entry", () => {
	const { info, entries } = host();
	info("memory guide + recalled 1 page", ["kp-1 — Conventions"]);
	expect(entries).toEqual([
		{
			type: "memory-info",
			data: {
				summary: "memory guide + recalled 1 page",
				details: ["kp-1 — Conventions"],
			},
		},
	]);
});

test("renders the summary always and the page ids only when expanded", () => {
	const { info, entries, renderer } = host();
	info("recalled 1 page", ["kp-1 — Conventions"]);
	const data = entries[0]?.data;

	const collapsed = renderer(entry(data), { expanded: false }, theme)?.render(48).join("\n");
	expect(collapsed).toContain("<dim>info · memory · recalled 1 page</dim>");
	expect(collapsed).not.toContain("kp-1");

	const expanded = renderer(entry(data), { expanded: true }, theme)?.render(120).join("\n");
	expect(expanded).toContain("kp-1 — Conventions");

	// An entry from another extension's payload renders nothing rather than throwing.
	expect(renderer(entry({ summary: 42 }), { expanded: false }, theme)).toBeUndefined();
});
