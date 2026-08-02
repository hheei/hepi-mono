import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import type { AgentConfig, AgentRecord } from "../types.js";
import type { AgentActivity } from "./agent-widget.js";
import { formatDuration, getDisplayName } from "./agent-widget.js";
import { ConversationViewer } from "./conversation-viewer.js";

const PANEL_ROWS = 20;
const WIDE_MIN_WIDTH = 96;

export type FleetAction =
	| { readonly kind: "close" }
	| { readonly kind: "create-manual" }
	| { readonly kind: "create-generated" }
	| { readonly kind: "edit"; readonly name: string }
	| { readonly kind: "toggle-enabled"; readonly name: string }
	| { readonly kind: "delete"; readonly name: string }
	| { readonly kind: "reset"; readonly name: string }
	| { readonly kind: "eject"; readonly name: string };

interface ActiveEntry {
	readonly kind: "active";
	readonly key: string;
	readonly record: AgentRecord;
}

interface DefinitionEntry {
	readonly kind: "definition";
	readonly key: string;
	readonly name: string;
	readonly config: AgentConfig;
}

interface SchedulesEntry {
	readonly kind: "schedules";
	readonly key: string;
	readonly count: number;
	readonly deferred: boolean;
}

type Entry = ActiveEntry | DefinitionEntry | SchedulesEntry;

export interface FleetSurfaceOptions {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly manager: AgentManager;
	readonly activity: ReadonlyMap<string, AgentActivity>;
	readonly listDefinitions: () => readonly string[];
	readonly getDefinition: (name: string) => AgentConfig | undefined;
	readonly getModelLabel: (name: string) => string;
	readonly scheduleCount: () => number;
	readonly scheduleDeferred: () => boolean;
	readonly initialSelection?: string;
	readonly onAction: (action: FleetAction) => void;
}

function rightAlign(left: string, right: string, width: number): string {
	const room = Math.max(0, width - visibleWidth(right) - 1);
	const leftPart = truncateToWidth(left, room);
	return truncateToWidth(
		`${leftPart}${" ".repeat(Math.max(1, width - visibleWidth(leftPart) - visibleWidth(right)))}${right}`,
		width,
	);
}

/** Domain-owned `/agents` view. Core owns only the surrounding custom-surface lifecycle. */
export class FleetSurface {
	private selectedIndex = 0;
	private viewer: ConversationViewer | undefined;

	constructor(private readonly options: FleetSurfaceOptions) {
		const initial = options.initialSelection;
		if (initial !== undefined) {
			const index = this.entries().findIndex((entry) => entry.key === initial);
			if (index >= 0) this.selectedIndex = index;
		}
	}

	handleInput(data: string): void {
		if (this.viewer !== undefined) {
			this.viewer.handleInput(data);
			return;
		}
		const entries = this.entries();
		if (matchesKey(data, Key.escape)) {
			this.options.onAction({ kind: "close" });
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(Math.max(0, entries.length - 1), this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		const selected = entries[this.selectedIndex];
		if (matchesKey(data, Key.enter)) {
			if (selected?.kind === "active") this.openConversation(selected.record);
			else if (selected?.kind === "definition")
				this.options.onAction({ kind: "edit", name: selected.name });
			return;
		}
		if (matchesKey(data, "c")) this.options.onAction({ kind: "create-manual" });
		else if (matchesKey(data, "g")) this.options.onAction({ kind: "create-generated" });
		else if (selected?.kind === "definition" && matchesKey(data, "e"))
			this.options.onAction({ kind: "edit", name: selected.name });
		else if (selected?.kind === "definition" && matchesKey(data, Key.space))
			this.options.onAction({ kind: "toggle-enabled", name: selected.name });
		else if (selected?.kind === "definition" && matchesKey(data, "d"))
			this.options.onAction({ kind: "delete", name: selected.name });
		else if (selected?.kind === "definition" && matchesKey(data, "r"))
			this.options.onAction({ kind: "reset", name: selected.name });
		else if (selected?.kind === "definition" && matchesKey(data, "x"))
			this.options.onAction({ kind: "eject", name: selected.name });
	}

	render(width: number): string[] {
		if (this.viewer !== undefined) return this.viewer.render(width);
		const entries = this.entries();
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, entries.length - 1));
		if (width >= WIDE_MIN_WIDTH) return this.renderWide(width, entries);
		return this.renderNarrow(width, entries);
	}

	invalidate(): void {
		this.viewer?.invalidate();
	}

	dispose(): void {
		this.viewer?.dispose();
		this.viewer = undefined;
	}

	private entries(): readonly Entry[] {
		const active = this.options.manager
			.listAgents()
			.filter(
				(record) =>
					record.status === "queued" ||
					record.status === "running" ||
					record.completedAt !== undefined,
			)
			.map((record) => ({ kind: "active" as const, key: `active:${record.id}`, record }));
		const definitions = this.options.listDefinitions().flatMap((name) => {
			const config = this.options.getDefinition(name);
			return config === undefined
				? []
				: [{ kind: "definition" as const, key: `definition:${name}`, name, config }];
		});
		return [
			...active,
			...definitions,
			{
				kind: "schedules",
				key: "schedules",
				count: this.options.scheduleCount(),
				deferred: this.options.scheduleDeferred(),
			},
		];
	}

	private openConversation(record: AgentRecord): void {
		const handle = record.handle;
		if (handle === undefined) return;
		this.viewer = new ConversationViewer(
			this.options.tui,
			handle,
			record,
			this.options.activity.get(record.id),
			this.options.theme,
			() => {
				this.viewer?.dispose();
				this.viewer = undefined;
				this.requestRender();
			},
			() => {
				this.options.manager.abort(record.id);
			},
			undefined,
			(message) => {
				this.options.manager.steer(record.id, message);
			},
		);
		this.requestRender();
	}

	private renderWide(width: number, entries: readonly Entry[]): string[] {
		const listWidth = Math.max(30, Math.floor(width * 0.46));
		const detailWidth = Math.max(20, width - listWidth - 3);
		const window = this.entryWindow(entries, 8);
		const list = this.listLines(listWidth, window.entries, window.start, entries.length);
		const detail = this.detailLines(detailWidth, entries[this.selectedIndex]);
		return Array.from({ length: PANEL_ROWS }, (_, index) => {
			const left = list[index] ?? "";
			const right = detail[index] ?? "";
			return truncateToWidth(
				`${left}${this.options.theme.fg("borderMuted", " │ ")}${right}`,
				width,
			);
		});
	}

	private renderNarrow(width: number, entries: readonly Entry[]): string[] {
		const listRows = Math.min(10, Math.max(5, Math.floor(PANEL_ROWS / 2)));
		const window = this.entryWindow(entries, Math.max(1, listRows - 3));
		const list = this.listLines(width, window.entries, window.start, entries.length).slice(
			0,
			listRows,
		);
		const detail = this.detailLines(width, entries[this.selectedIndex]);
		return [
			...list,
			this.options.theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
			...detail,
		].slice(0, PANEL_ROWS);
	}

	private entryWindow(
		entries: readonly Entry[],
		capacity: number,
	): { start: number; entries: readonly Entry[] } {
		if (entries.length <= capacity) return { start: 0, entries };
		const start = Math.min(
			Math.max(0, this.selectedIndex - capacity + 1),
			entries.length - capacity,
		);
		return { start, entries: entries.slice(start, start + capacity) };
	}

	private listLines(
		width: number,
		entries: readonly Entry[],
		start: number,
		total: number,
	): string[] {
		const lines = [
			this.options.theme.bold("Agent Fleet"),
			...(total > entries.length
				? [this.options.theme.fg("dim", `scroll ${start + 1}-${start + entries.length}/${total}`)]
				: []),
		];
		let group: Entry["kind"] | undefined;
		for (const [localIndex, entry] of entries.entries()) {
			const index = start + localIndex;
			if (entry.kind !== group) {
				group = entry.kind;
				lines.push(
					this.options.theme.fg(
						"muted",
						group === "active"
							? "Active"
							: group === "definition"
								? "Agent definitions"
								: "Schedules",
					),
				);
			}
			const selected = index === this.selectedIndex;
			const marker = selected ? this.options.theme.fg("accent", "→ ") : "  ";
			lines.push(truncateToWidth(`${marker}${this.entryLabel(entry)}`, width));
		}
		lines.push("");
		lines.push(
			this.options.theme.fg("dim", "↑↓ select · ↵ open · c create · g generate · Esc close"),
		);
		return lines;
	}

	private entryLabel(entry: Entry): string {
		if (entry.kind === "active") {
			const status = entry.record.status === "running" ? "●" : "○";
			return rightAlign(
				`${this.options.theme.fg(entry.record.status === "running" ? "accent" : "muted", status)} ${getDisplayName(entry.record.type)} ${entry.record.description}`,
				this.options.theme.fg(
					"dim",
					formatDuration(entry.record.startedAt, entry.record.completedAt),
				),
				60,
			);
		}
		if (entry.kind === "definition") {
			const status =
				entry.config.enabled === false
					? this.options.theme.fg("dim", "○")
					: this.options.theme.fg("success", "✓");
			return `${status} ${entry.name} ${this.options.theme.fg("dim", entry.config.source ?? "built-in")}`;
		}
		return `${this.options.theme.fg("dim", "○")} ${entry.count} scheduled jobs${entry.deferred ? " (deferred)" : ""}`;
	}

	private detailLines(width: number, entry: Entry | undefined): string[] {
		if (entry === undefined) return [this.options.theme.fg("muted", "No agents or definitions.")];
		if (entry.kind === "active") {
			return [
				this.options.theme.bold(getDisplayName(entry.record.type)),
				this.options.theme.fg("muted", entry.record.description),
				this.options.theme.fg("dim", `status: ${entry.record.status}`),
				this.options.theme.fg("dim", "Enter view live conversation"),
			];
		}
		if (entry.kind === "schedules") {
			return [
				this.options.theme.bold("Schedules"),
				this.options.theme.fg(
					"muted",
					`${entry.count} configured jobs${entry.deferred ? " (deferred)" : ""}`,
				),
				this.options.theme.fg("dim", "Schedule management is not in this Fleet slice."),
			];
		}
		const config = entry.config;
		const source = config.source ?? "built-in";
		const tools = config.builtinToolNames?.join(", ") ?? "all built-in tools";
		return [
			this.options.theme.bold(entry.name),
			this.options.theme.fg("muted", config.description),
			this.options.theme.fg("dim", `source: ${source}`),
			this.options.theme.fg("dim", `model: ${this.options.getModelLabel(entry.name)}`),
			this.options.theme.fg("dim", `tools: ${tools}`),
			this.options.theme.fg("dim", `status: ${config.enabled === false ? "disabled" : "enabled"}`),
			this.options.theme.fg("dim", "Enter/e edit · Space enable/disable · d delete"),
			this.options.theme.fg("dim", "r reset default · x eject"),
		].map((line) => truncateToWidth(line, width));
	}

	private requestRender(): void {
		this.options.tui.requestRender();
	}
}
