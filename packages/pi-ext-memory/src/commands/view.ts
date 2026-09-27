import {
	copyToClipboard as copyToSystemClipboard,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@hheei/pi-ext-core";
import type { Runtime } from "../runtime.js";
import {
	type Entry,
	fullProjection,
	observationToSummaryLine,
	type Projection,
	reflectionToSummaryLine,
	visibleProjection,
} from "../session-ledger/index.js";

function firstArg(args: unknown): string | undefined {
	if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
	if (typeof args === "string") return args.trim().split(/\s+/)[0];
	if (args && typeof args === "object" && "mode" in args) {
		const mode = (args as { mode?: unknown }).mode;
		return typeof mode === "string" ? mode : undefined;
	}
	return undefined;
}

function renderList<T>(items: T[], render: (item: T) => string, empty: string): string {
	return items.length > 0 ? items.map(render).join("\n") : empty;
}

function renderContentOnlyProjection(
	projection: Projection,
	emptyScope: "visible" | "recorded",
): string {
	return [
		"── Reflections ──",
		renderList(projection.reflections, reflectionToSummaryLine, `No ${emptyScope} reflections.`),
		"",
		"── Observations ──",
		renderList(projection.observations, observationToSummaryLine, `No ${emptyScope} observations.`),
	].join("\n");
}

export interface ViewCommandOptions {
	copyToClipboard?: (text: string) => Promise<void>;
}

export async function runViewCommand(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: string,
	options: ViewCommandOptions = {},
): Promise<void> {
	const copyToClipboard = options.copyToClipboard ?? copyToSystemClipboard;
	await runtime.ensureConfig(ctx.cwd, runtime.lifecycleSignal);
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const mode = firstArg(args);

	// Pi's clipboard helper resolves once the text reached a clipboard (native, platform
	// command or OSC 52) and rejects with the reason it could not, so the notice can say why.
	const notifyWithCopy = async (output: string) => {
		let note = "Copied /om view output to clipboard.";
		try {
			await copyToClipboard(output);
		} catch (error) {
			note = `Warning: could not copy /om view output: ${errorMessage(error)}`;
		}
		ctx.ui.notify(`${output}\n\n${note}`, "info");
	};

	if (mode === "full") {
		await notifyWithCopy(renderContentOnlyProjection(fullProjection(entries), "recorded"));
		return;
	}

	if (mode && mode !== "visible") {
		ctx.ui.notify("Usage: /om view [full]", "info");
		return;
	}

	await notifyWithCopy(renderContentOnlyProjection(visibleProjection(entries), "visible"));
}
