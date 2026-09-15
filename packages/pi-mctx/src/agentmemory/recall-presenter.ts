import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerWidget } from "@hheei/pi-ext-core";
import type { Database } from "../core/shared/sqlite";
import { type RecallEvent, RecallLedger } from "./recall";

const PRESENTATION_KEY = "above-editor";
const MAX_EVENTS = 4;
const MAX_SOURCE_CHARS = 240;

function sanitizePreview(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_SOURCE_CHARS);
}

export function readRecentRecallPreview(db: Database, sessionId: string): string[] {
	try {
		const rows = db
			.prepare(
				`SELECT source.kind, source.content
				 FROM mctx_recall_events AS event
				 JOIN mctx_recall_sources AS source ON source.event_id = event.id
				 WHERE event.session_id = ? AND event.status = 'admitted'
				 ORDER BY event.created_at DESC, source.source_id LIMIT 3`,
			)
			.all(sessionId.trim()) as Array<{ kind: string; content: string }>;
		return rows.map((row) => `[${sanitizePreview(row.kind)}] ${sanitizePreview(row.content)}`);
	} catch {
		return [];
	}
}

function render(events: readonly RecallEvent[], width: number, theme: Theme): string[] {
	if (events.length === 0) return [];
	const lines = [truncateToWidth(theme.fg("accent", "AgentMemory recall"), width, "...")];
	for (const event of events) {
		const source = event.sources[0];
		if (!source) continue;
		const text = sanitizePreview(source.content);
		const extra =
			event.sources.length > 1 ? theme.fg("dim", ` (+${event.sources.length - 1})`) : "";
		lines.push(
			truncateToWidth(
				truncateToWidth(
					theme.fg("text", `• ${text}`),
					Math.max(0, width - visibleWidth(extra)),
					"...",
				) + extra,
				width,
				"...",
			),
		);
	}
	lines.push("");
	return lines;
}

export interface RecallPresenter {
	present(sessionId: string): void;
	dispose(): void;
}

export function createRecallPresenter(
	pi: ExtensionAPI,
	context: ExtensionContext,
	signal: AbortSignal,
	db: Database,
): RecallPresenter | undefined {
	if (context.mode !== "tui") return undefined;
	const ledger = new RecallLedger(db);
	const ownerToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	let events: RecallEvent[] = [];
	let pending: RecallEvent[] = [];
	const widget = registerWidget(pi, context, signal, {
		id: "pi-mctx:agentmemory-recall",
		placement: "aboveEditor",
		visible: false,
		create: (_tui, theme) => ({
			render: (width) => {
				const lines = render(pending.length > 0 ? pending : events, width, theme);
				if (pending.length > 0) {
					events = pending.filter((event) =>
						ledger.completePresentation(event.id, PRESENTATION_KEY, ownerToken),
					);
					pending = [];
				}
				return lines;
			},
			invalidate: () => undefined,
		}),
	});
	return {
		present(sessionId: string) {
			try {
				const claimed = ledger.claimUnpresented({
					sessionId,
					presentationKey: PRESENTATION_KEY,
					ownerToken,
					limit: MAX_EVENTS,
				});
				if (claimed.length === 0) return;
				events = claimed;
				pending = claimed;
				widget.setVisible(true);
				widget.requestRender(true);
			} catch {
				pending = [];
				widget.setVisible(false);
				// The lease expires so a later presentation can retry.
			}
		},
		dispose: widget.dispose,
	};
}
