import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import {
	createSplitLayout,
	formatKeymap,
	keyGlyph,
	padToWidth,
	renderDetailPanel,
	renderSelectableRow,
	truncateToWidth,
	wrap,
} from "../../../hepi-basics/src/core/index.js";

export type PlanThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type PlanImplementationMode = "compact" | "new" | "continue";
export type PlanConfirmationAction = PlanImplementationMode | "refine";

/** Minimal model shape accepted from ModelRegistry values. */
export interface PlanConfirmationModel {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
}

export type PlanConfirmationResult =
	| { readonly status: "cancelled" }
	| {
			readonly status: "selected";
			readonly action: PlanConfirmationAction;
			readonly model: PlanConfirmationModel;
			readonly thinkingLevel: PlanThinkingLevel;
	  };

export interface PlanConfirmationComponentOptions {
	readonly plan: string;
	readonly model: PlanConfirmationModel;
	readonly availableModels: readonly PlanConfirmationModel[];
	readonly thinkingLevel?: PlanThinkingLevel;
	readonly selectModel: (model: PlanConfirmationModel) => Promise<boolean>;
	readonly setThinkingLevel: (level: PlanThinkingLevel) => void;
	readonly getThinkingLevel: () => PlanThinkingLevel;
	readonly host: { readonly requestRender: () => void };
	readonly theme: Theme;
	readonly done: (result: PlanConfirmationResult) => void;
	readonly onModelSwitchError?: (error: unknown, model: PlanConfirmationModel) => void;
}

type Focus = "model" | "implement" | "refine";
const levels: readonly PlanThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const modes: readonly PlanImplementationMode[] = ["compact", "new", "continue"];

function finish(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, width, ""), width);
}

function defined<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

export function createPlanConfirmationComponent(
	options: PlanConfirmationComponentOptions,
): Component {
	const models = options.availableModels.length ? options.availableModels : [options.model];
	let modelIndex = Math.max(
		0,
		models.findIndex(
			(candidate) =>
				candidate.provider === options.model.provider && candidate.id === options.model.id,
		),
	);
	let level = defined(
		options.thinkingLevel ?? options.getThinkingLevel(),
		"Plan confirmation thinking level is unavailable",
	);
	let mode: PlanImplementationMode = "compact";
	let focus: Focus = "model";
	let width = 80;
	let switching = false;
	let settled = false;

	function requestRender(): void {
		options.host.requestRender();
	}
	function settle(result: PlanConfirmationResult): void {
		if (settled) return;
		settled = true;
		options.done(result);
	}
	function changeModel(delta: -1 | 1): void {
		if (switching || models.length < 2) return;
		const next = (modelIndex + delta + models.length) % models.length;
		const candidate = defined(models[next], "Plan confirmation model is unavailable");
		switching = true;
		requestRender();
		void Promise.resolve()
			.then(() => options.selectModel(candidate))
			.then((ok) => {
				if (ok) modelIndex = next;
				else options.onModelSwitchError?.(new Error("Model selection rejected"), candidate);
			})
			.catch((error: unknown) => options.onModelSwitchError?.(error, candidate))
			.finally(() => {
				switching = false;
				requestRender();
			});
	}
	function changeLevel(delta: -1 | 1): void {
		const current = levels.indexOf(level);
		const next = (current < 0 ? 0 : current + delta + levels.length) % levels.length;
		level = defined(levels[next], "Plan confirmation thinking level is unavailable");
		options.setThinkingLevel(level);
		requestRender();
	}
	function select(action: PlanConfirmationAction): void {
		settle({
			status: "selected",
			action,
			model: defined(models[modelIndex], "Plan confirmation model is unavailable"),
			thinkingLevel: level,
		});
	}
	function description(): string[] {
		if (focus === "model") {
			const model = defined(models[modelIndex], "Plan confirmation model is unavailable");
			return [
				`${model.provider}/${model.id}`,
				"Only models with configured authentication are shown.",
				switching ? "Switching model…" : "Use left/right to cycle models.",
				"Tab changes thinking level.",
			];
		}
		if (focus === "refine")
			return ["Continue planning and revise", "this plan before implementation."];
		return [
			`Implement using ${mode} mode.`,
			mode === "compact"
				? "Compact context first."
				: mode === "new"
					? "Start in a new session."
					: "Continue in this session.",
		];
	}
	function renderPanel(panelWidth: number, height: number): string[] {
		const inner = Math.max(1, panelWidth - 4);
		const content = description().flatMap((line) => wrap(line, inner));
		return renderDetailPanel({
			width: Math.max(2, panelWidth),
			height,
			content,
			theme: { content: (text) => options.theme.fg("muted", text) },
		}).map((line) => finish(line, panelWidth));
	}
	function render(nextWidth: number): string[] {
		width = Math.max(0, Math.floor(nextWidth));
		if (width === 0) return [];
		const split = createSplitLayout({
			width,
			breakpoint: 75,
			gap: 3,
			leftMin: 24,
			leftMax: 42,
			rightMin: 32,
			rightMax: 44,
			leftRatio: 0.58,
		});
		const showDescription = split.mode === "split";
		const controlsWidth = split.leftWidth;
		const panelWidth = split.rightWidth;
		const planLines = wrap(options.plan, Math.max(1, width)).slice(0, 8);
		const model = defined(models[modelIndex], "Plan confirmation model is unavailable");
		const row = (focusRow: Focus, label: string): string =>
			renderSelectableRow({ width: controlsWidth, selected: focus === focusRow, label });
		const controls = [
			"model:",
			row("model", `${model.provider}/${model.name} (${level})`),
			"",
			"action:",
			row("implement", `implement (${mode})`),
			row("refine", "refine"),
		];
		const footer = formatKeymap(
			[
				{ key: keyGlyph.vertical, label: "focus", priority: 2 },
				{ key: keyGlyph.horizontal, label: "change", priority: 1 },
				{ key: keyGlyph.tab, label: "thinking", priority: 2 },
				{ key: keyGlyph.confirm, label: "select", priority: 3 },
				{ key: keyGlyph.cancel, label: "cancel", priority: 3 },
			],
			{ width, separator: " · " },
		);
		const top = [
			options.theme.bold("plan:"),
			...planLines.map((line) => options.theme.fg("muted", line)),
			"",
		];
		if (!showDescription)
			return [...top, ...controls.map((line) => finish(line, width)), finish(footer, width)];
		const bodyHeight = Math.max(controls.length, 9);
		const panel = renderPanel(panelWidth, bodyHeight);
		const body = Array.from(
			{ length: bodyHeight },
			(_, index) =>
				`${finish(controls[index] ?? "", controlsWidth)}${" ".repeat(3)}${finish(
					panel[index] ?? "",
					panelWidth,
				)}`,
		);
		return [...top, ...body, finish(footer, width)];
	}
	function handleInput(input: string): void {
		if (settled) return;
		if (matchesKey(input, Key.escape)) {
			settle({ status: "cancelled" });
			return;
		}
		if (matchesKey(input, Key.up) || matchesKey(input, Key.down)) {
			const order: readonly Focus[] = ["model", "implement", "refine"];
			const index = order.indexOf(focus) + (matchesKey(input, Key.up) ? -1 : 1);
			focus = defined(
				order[Math.max(0, Math.min(order.length - 1, index))],
				"Plan confirmation focus is unavailable",
			);
			requestRender();
			return;
		}
		if (focus === "model" && matchesKey(input, Key.tab)) {
			changeLevel(1);
			return;
		}
		if (focus === "model" && matchesKey(input, Key.left)) {
			changeModel(-1);
			return;
		}
		if (focus === "model" && matchesKey(input, Key.right)) {
			changeModel(1);
			return;
		}
		if (focus === "implement" && (matchesKey(input, Key.left) || matchesKey(input, Key.right))) {
			const index = modes.indexOf(mode);
			mode = defined(
				modes[(index + (matchesKey(input, Key.left) ? -1 : 1) + modes.length) % modes.length],
				"Plan confirmation implementation mode is unavailable",
			);
			requestRender();
			return;
		}
		if (
			(focus === "implement" || focus === "refine") &&
			(matchesKey(input, Key.enter) || matchesKey(input, Key.space))
		)
			select(focus === "refine" ? "refine" : mode);
	}
	return { render, handleInput, invalidate: requestRender };
}
