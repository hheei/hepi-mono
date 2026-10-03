import type { Entry } from "./types.js";

interface SessionManagerWithContextEdit {
	appendContextEdit(targetId: string, replacement: { content: unknown } | null): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasAppendContextEdit(value: unknown): value is SessionManagerWithContextEdit {
	return (
		isRecord(value) &&
		"appendContextEdit" in value &&
		typeof (value as { appendContextEdit?: unknown }).appendContextEdit === "function"
	);
}

function extractEncryptedContentInfo(block: Record<string, unknown>): {
	hasEncryptedContent: boolean;
	summaryText?: string | undefined;
} {
	const sig = block.thinkingSignature;
	if (typeof sig === "string") {
		if (sig.includes("encrypted_content")) {
			let summaryText: string | undefined;
			try {
				const parsed: unknown = JSON.parse(sig);
				if (isRecord(parsed) && Array.isArray(parsed.summary)) {
					const texts = parsed.summary
						.filter(isRecord)
						.map((s) => (typeof s.text === "string" ? s.text : ""))
						.filter((t) => t.length > 0);
					if (texts.length > 0) {
						summaryText = texts.join("\n\n");
					}
				}
			} catch {
				// not valid JSON, but contains encrypted_content string
			}
			return { hasEncryptedContent: true, summaryText };
		}
	} else if (isRecord(sig)) {
		if ("encrypted_content" in sig) {
			let summaryText: string | undefined;
			if (Array.isArray(sig.summary)) {
				const texts = sig.summary
					.filter(isRecord)
					.map((s) => (typeof s.text === "string" ? s.text : ""))
					.filter((t) => t.length > 0);
				if (texts.length > 0) {
					summaryText = texts.join("\n\n");
				}
			}
			return { hasEncryptedContent: true, summaryText };
		}
	}

	if ("encrypted_content" in block || block.redacted === true) {
		return { hasEncryptedContent: true };
	}

	return { hasEncryptedContent: false };
}

export interface SanitizedAssistantContentResult {
	content: unknown[];
	modified: boolean;
}

/**
 * Sanitizes thinking blocks carrying encrypted_content (ciphertext) from assistant message content.
 *
 * Normal thinking blocks without encrypted_content are left untouched.
 * For thinking blocks that contain encrypted_content (e.g. OpenAI/Azure reasoning ciphertext or redacted thinking):
 * - If readable thinking or summary text exists, the thinking block is preserved with the readable text,
 *   while the encrypted_content/thinkingSignature ciphertext is stripped.
 * - If no readable thinking text exists (pure ciphertext), the thinking block is omitted.
 */
export function sanitizeAssistantContent(content: unknown): SanitizedAssistantContentResult {
	if (typeof content === "string") {
		return { content: [{ type: "text", text: content }], modified: false };
	}
	if (!Array.isArray(content)) {
		return { content: [], modified: false };
	}

	let modified = false;
	const sanitized: unknown[] = [];

	for (const block of content) {
		if (!isRecord(block)) {
			sanitized.push(block);
			continue;
		}

		if (block.type === "thinking") {
			const { hasEncryptedContent, summaryText } = extractEncryptedContentInfo(block);
			if (!hasEncryptedContent) {
				// Normal thinking block without encrypted_content - keep as-is!
				sanitized.push(block);
				continue;
			}

			// Contains encrypted_content: sanitize the ciphertext
			modified = true;
			const thinkingText =
				typeof block.thinking === "string" && block.thinking.trim().length > 0
					? block.thinking
					: (summaryText ?? "");

			if (thinkingText.length > 0) {
				// Preserve the readable thinking text while removing the encrypted signature
				sanitized.push({
					type: "thinking",
					thinking: thinkingText,
				});
			}
			// If thinkingText is empty (pure ciphertext), the block is omitted
			continue;
		}

		if (block.type === "text") {
			if (
				typeof block.textSignature === "string" &&
				block.textSignature.includes("encrypted_content")
			) {
				modified = true;
				sanitized.push({
					type: "text",
					text: typeof block.text === "string" ? block.text : "",
				});
			} else {
				sanitized.push(block);
			}
			continue;
		}

		if (block.type === "toolCall") {
			if (
				typeof block.thoughtSignature === "string" &&
				block.thoughtSignature.includes("encrypted_content")
			) {
				modified = true;
				const { thoughtSignature: _, ...rest } = block;
				sanitized.push(rest);
			} else {
				sanitized.push(block);
			}
			continue;
		}

		sanitized.push(block);
	}

	// If all blocks were omitted (e.g. message only contained pure encrypted ciphertext),
	// ensure the message is not left with an empty content array.
	if (sanitized.length === 0) {
		sanitized.push({
			type: "text",
			text: "",
		});
	}

	return { content: sanitized, modified };
}

export interface SanitizeRetainedAssistantMessagesResult {
	sanitizedEntries: Entry[];
	editCount: number;
}

/**
 * Sanitizes assistant messages in the retained tail (from firstKeptEntryId onwards).
 *
 * For each assistant message containing thinking blocks with encrypted_content,
 * appends a context_edit entry to the session manager (if available) and returns an
 * updated entries array so that subsequent token budget calculations reflect the
 * reduced footprint.
 */
export function sanitizeRetainedAssistantMessages(
	entries: Entry[],
	firstKeptEntryId: string,
	sessionManager?: unknown,
): SanitizeRetainedAssistantMessagesResult {
	const startIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (startIndex < 0) {
		return { sanitizedEntries: entries, editCount: 0 };
	}

	const canAppendEdit = hasAppendContextEdit(sessionManager);
	const sanitizedEntries = [...entries];
	let editCount = 0;

	for (let index = startIndex; index < entries.length; index++) {
		const entry = entries[index];
		if (
			entry?.type !== "message" ||
			!isRecord(entry.message) ||
			entry.message.role !== "assistant"
		) {
			continue;
		}

		const { content, modified } = sanitizeAssistantContent(entry.message.content);
		if (!modified) {
			continue;
		}

		if (canAppendEdit) {
			try {
				sessionManager.appendContextEdit(entry.id, { content });
			} catch {
				// Context edit failure is non-fatal for compaction
			}
		}

		sanitizedEntries[index] = {
			...entry,
			message: {
				...entry.message,
				content,
			},
		};
		editCount++;
	}

	return { sanitizedEntries, editCount };
}
