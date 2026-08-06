import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { planMctxProcessedImageStrips, stripMctxProcessedImages } from "../src/processed-images.js";
import type { MctxHistoryTag } from "../src/store.js";

const imageData = "a".repeat(201);
const userMessage = {
	role: "user" as const,
	content: [{ type: "image" as const, mimeType: "image/png", data: imageData }],
	timestamp: 1,
};
const assistantMessage = {
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "done" }],
	timestamp: 2,
};
const entries = [
	{
		type: "message",
		id: "image-user",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: userMessage,
	},
	{
		type: "message",
		id: "assistant",
		parentId: "image-user",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: assistantMessage,
	},
] as SessionEntry[];
const tags: MctxHistoryTag[] = [
	{
		kind: "reference",
		entryId: "image-user",
		source: JSON.stringify([
			{ type: "image", mimeType: "image/png", byteLength: imageData.length },
		]),
		tagNumber: 3,
		status: "active",
	},
	{
		kind: "message",
		entryId: "assistant",
		source: '[{"type":"text","text":"done"}]',
		tagNumber: 4,
		status: "active",
	},
];

test("plans only persisted, aged image entries after an assistant response", (): void => {
	expect(
		planMctxProcessedImageStrips({
			entries,
			tags,
			reasoningWatermark: 3,
			execute: true,
		}),
	).toEqual(["image-user"]);
	expect(
		planMctxProcessedImageStrips({
			entries,
			tags,
			reasoningWatermark: 2,
			execute: true,
		}),
	).toEqual([]);
});

test("replays strips through a pre-tag identity index", (): void => {
	const user = {
		role: "user" as const,
		content: [
			{ type: "text" as const, text: "§1§ inspect" },
			{ type: "image" as const, data: "x".repeat(201), mimeType: "image/png" },
		],
		timestamp: 1,
	};
	const entry = {
		type: "message",
		id: "user",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			...user,
			content: [{ type: "text" as const, text: "inspect" }, ...user.content.slice(1)],
		},
	} as SessionEntry;
	const result = stripMctxProcessedImages(
		[user],
		[entry],
		new Set(["user"]),
		new Map([["user", 0]]),
	);
	expect(result[0]).toMatchObject({
		content: [
			{ type: "text", text: "§1§ inspect" },
			{ type: "text", text: "[image stripped]" },
		],
	});
});

test("replays persisted image strips without changing other messages", (): void => {
	const messages = structuredClone([userMessage, assistantMessage]);
	const stripped = stripMctxProcessedImages(messages, entries, new Set(["image-user"]));
	expect(stripped[0]).toMatchObject({ content: [{ type: "text", text: "[image stripped]" }] });
	expect(stripped[1]).toEqual(assistantMessage);
});
