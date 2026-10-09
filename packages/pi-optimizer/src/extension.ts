import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
	setPromptSection,
} from "@hheei/pi-ext-core";
import { createOptimizerInfo } from "./info.js";
import { convertInputText } from "./model.js";
import { type OptimizerSession, registerOptimizerCommand } from "./opt.js";
import { buildOptimizerPrompt, OPTIMIZER_PROMPT_SECTION } from "./prompt.js";
import { createRtkRuntime } from "./rtk.js";
import {
	createOptimizerSettingsProvider,
	DEFAULT_OPTIMIZER_SETTINGS,
	parseOptimizerSettings,
} from "./settings.js";

export default function piOptimizerExtension(
	pi: ExtensionAPI,
	options: { readonly settingsPath?: string } = {},
): void {
	let active: (OptimizerSession & { readonly sessionId: string }) | undefined;
	const info = createOptimizerInfo(pi);
	const rtk = createRtkRuntime(pi, info);
	const getSession = (context: ExtensionContext): typeof active =>
		active && !active.signal.aborted && active.sessionId === context.sessionManager.getSessionId()
			? active
			: undefined;

	let lastReportedPromptModes: string | undefined;
	let t2sReported = false;

	pi.on("input", (event, context) => {
		if (event.source !== "interactive" || getSession(context)?.settings.t2s.mode !== "t2s") return;
		const text = convertInputText(event.text);
		if (text === event.text) return;
		if (!t2sReported) {
			t2sReported = true;
			info("T2S · Traditional → Simplified", { original: event.text, transformed: text });
		}
		return { action: "transform", text };
	});
	pi.on("before_agent_start", (event, context) => {
		const session = getSession(context);
		if (!session) return;
		const prompt = buildOptimizerPrompt(session.settings);
		if (!prompt) return;
		const { caveman, ponytail, rtk } = session.settings;
		const modes = [
			caveman.level !== "off" && `Caveman ${caveman.level}`,
			ponytail.level !== "off" && `Ponytail ${ponytail.level}`,
			rtk.enabled && "RTK",
		]
			.filter(Boolean)
			.join(" · ");
		if (modes && lastReportedPromptModes !== modes) {
			lastReportedPromptModes = modes;
			info(`Prompt · ${modes}`, { prompt });
		}
		setPromptSection(event.systemPromptOptions.sections, OPTIMIZER_PROMPT_SECTION, prompt);
	});
	pi.on("tool_call", async (event, context) => {
		const session = getSession(context);
		if (session) await rtk.rewrite(event, context, session.settings.rtk);
	});
	registerOptimizerCommand(pi, getSession, info);

	registerExtensionLifecycle(pi, {
		key: "pi-optimizer",
		start: async (runtime): Promise<void> => {
			const context = {
				sessionId: runtime.extension.sessionManager.getSessionId(),
				cwd: runtime.extension.cwd,
				signal: runtime.signal,
			};
			let session: OptimizerSession & { readonly sessionId: string };
			const provider = createOptimizerSettingsProvider({
				...(options.settingsPath === undefined ? {} : { path: options.settingsPath }),
				onSaved(settings): void {
					if (active !== session || session.signal.aborted) return;
					session.settings = settings;
					lastReportedPromptModes = undefined;
					t2sReported = false;
					info("Settings saved", settings);
				},
			});
			let pendingSave = Promise.resolve();
			session = {
				...context,
				provider,
				settings: { ...DEFAULT_OPTIMIZER_SETTINGS, t2s: { mode: "off" } },
				update(transform): Promise<void> {
					const pending = pendingSave.then(async () => {
						runtime.signal.throwIfAborted();
						await provider.storage.save(
							parseOptimizerSettings(transform(session.settings)),
							context,
						);
					});
					pendingSave = pending.catch(() => undefined);
					return pending;
				},
			};
			active = session;
			lastReportedPromptModes = undefined;
			t2sReported = false;
			rtk.reset();
			runtime.resources.add("optimizer-session", () => {
				if (active === session) active = undefined;
				rtk.reset();
			});
			runtime.resources.add(
				"optimizer-settings",
				registerSettings(provider, getRuntimeSettingsRegistry(pi)),
			);
			try {
				const stored = await provider.storage.load(context);
				runtime.signal.throwIfAborted();
				if (active === session) session.settings = parseOptimizerSettings(stored);
			} catch (error) {
				if (active === session && !runtime.signal.aborted)
					info(`Unable to load optimizer settings: ${errorMessage(error)}`, undefined, true);
			}
		},
	});
}
