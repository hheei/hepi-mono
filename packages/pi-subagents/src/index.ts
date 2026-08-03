/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /subagent-schedules  — list or remove persisted scheduled jobs
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	type ConversationSubagentHandle,
	configureSubagentCoordinator,
	DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
	type ExtensionLifecycleContext,
	getHepiRuntimeSettingsRegistry,
	hepiThinkingGlyph,
	observeLoadoutToolActivation,
	registerExtensionLifecycle,
	registerHepiWidget,
	registerLoadoutResource,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { type AgentDetail, createAgentDetail } from "./agent-detail.js";
import { AgentManager, type SpawnOptions } from "./agent-manager.js";
import {
	normalizeMaxTurns,
	SUBAGENT_TOOL_NAMES,
	setDefaultMaxTurns,
	setGraceTurns,
	steerAgent,
} from "./agent-runner.js";
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getAllTypes,
	getAvailableTypes,
	isLoadoutResourceDisabled,
	registerAgents,
	resolveType,
	setDefaultsDisabled,
	setLoadoutActivation,
} from "./agent-types.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { GroupJoinManager } from "./group-join.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import {
	applyAndEmitLoaded,
	createSubagentsSettingsProvider,
	type ToolDescriptionMode,
} from "./settings.js";
import { getStatusNote } from "./status-note.js";
import type {
	AgentConfig,
	AgentInvocation,
	AgentRecord,
	JoinMode,
	NotificationDetails,
	SubagentType,
	WidgetMode,
} from "./types.js";
import {
	type AgentActivity,
	type AgentDetails,
	AgentWidget,
	buildInvocationTags,
	describeActivity,
	fgPreservingNestedStyles,
	formatDuration,
	formatMs,
	formatTokens,
	formatTurns,
	getDisplayName,
	getPromptModeLabel,
	SPINNER,
	type Theme,
} from "./ui/agent-widget.js";
import { addUsage, getLifetimeTotal, type LifetimeUsage } from "./usage.js";

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
	return { content: [{ type: "text" as const, text: msg }], details };
}

/** Await a promise until it settles or the caller cancels, without aborting the underlying work. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(signal.reason);
		};

		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

export function renderRunningAgentStatus(
	frame: string,
	statsText: string,
	activity: string,
	theme: Pick<Theme, "fg">,
): Container {
	const container = new Container();
	container.addChild(
		new Text(theme.fg("accent", frame) + (statsText ? ` ${statsText}` : ""), 0, 0),
	);
	container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
	return container;
}

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
	const t = getLifetimeTotal(o.lifetimeUsage);
	return t > 0 ? formatTokens(t) : "";
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
	const state: AgentActivity = {
		activeTools: new Map(),
		toolUses: 0,
		turnCount: 1,
		...(maxTurns === undefined ? {} : { maxTurns }),
		responseText: "",
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
	};

	const callbacks = {
		onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
			if (activity.type === "start") {
				state.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
			} else {
				for (const [key, name] of state.activeTools) {
					if (name === activity.toolName) {
						state.activeTools.delete(key);
						break;
					}
				}
				state.toolUses++;
			}
			onStreamUpdate?.();
		},
		onTextDelta: (_delta: string, fullText: string) => {
			state.responseText = fullText;
			onStreamUpdate?.();
		},
		onTurnEnd: (turnCount: number) => {
			state.turnCount = turnCount;
			onStreamUpdate?.();
		},
		onSessionCreated: (_handle: ConversationSubagentHandle) => undefined,
		onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
			addUsage(state.lifetimeUsage, usage);
			onStreamUpdate?.();
		},
	};

	return { state, callbacks };
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
function partialOutputSuffix(record: AgentRecord): string {
	const partial = record.result?.trim();
	return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
	switch (status) {
		case "error":
			return `Error: ${error ?? "unknown"}`;
		case "aborted":
			return "Aborted (max turns exceeded)";
		case "steered":
			return "Wrapped up (turn limit)";
		case "stopped":
			return "Stopped";
		default:
			return "Done";
	}
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
	const status = getStatusLabel(record.status, record.error);
	const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
	const totalTokens = getLifetimeTotal(record.lifetimeUsage);
	const contextPercent = record.contextPercent ?? null;
	const ctxXml =
		contextPercent !== null
			? `<context_percent>${Math.round(contextPercent)}</context_percent>`
			: "";
	const compactXml = record.compactionCount
		? `<compactions>${record.compactionCount}</compactions>`
		: "";

	const resultPreview = record.result
		? record.result.length > resultMaxLen
			? record.result.slice(0, resultMaxLen) +
				"\n...(truncated, use get_subagent_result for full output)"
			: record.result
		: "No output.";

	return [
		`<task-notification>`,
		`<task-id>${record.id}</task-id>`,
		record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
		record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
		`<status>${escapeXml(status)}</status>`,
		`<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
		`<result>${escapeXml(resultPreview)}</result>`,
		`<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
		`</task-notification>`,
	]
		.filter(Boolean)
		.join("\n");
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
	base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
	record: {
		toolUses: number;
		startedAt: number;
		completedAt?: number;
		status: string;
		error?: string;
		id?: string;
		lifetimeUsage: LifetimeUsage;
	},
	activity?: AgentActivity,
	overrides?: Partial<AgentDetails>,
): AgentDetails {
	const details: AgentDetails = {
		...base,
		toolUses: record.toolUses,
		tokens: formatLifetimeTokens(record),
		durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
		status: record.status as AgentDetails["status"],
	};
	if (activity?.turnCount !== undefined) details.turnCount = activity.turnCount;
	if (activity?.maxTurns !== undefined) details.maxTurns = activity.maxTurns;
	if (record.id !== undefined) details.agentId = record.id;
	if (record.error !== undefined) details.error = record.error;
	return { ...details, ...overrides };
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(
	record: AgentRecord,
	resultMaxLen: number,
	activity?: AgentActivity,
): NotificationDetails {
	const totalTokens = getLifetimeTotal(record.lifetimeUsage);

	return {
		id: record.id,
		description: record.description,
		status: record.status,
		toolUses: record.toolUses,
		turnCount: activity?.turnCount ?? 0,
		...(activity?.maxTurns === undefined ? {} : { maxTurns: activity.maxTurns }),
		totalTokens,
		durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
		...(record.outputFile === undefined ? {} : { outputFile: record.outputFile }),
		...(record.error === undefined ? {} : { error: record.error }),
		resultPreview: record.result
			? record.result.length > resultMaxLen
				? `${record.result.slice(0, resultMaxLen)}…`
				: record.result
			: "No output.",
	};
}

export default function (pi: ExtensionAPI) {
	// ---- Register custom notification renderer ----
	pi.registerMessageRenderer<NotificationDetails>(
		"subagent-notification",
		(message, { expanded }, theme) => {
			const d = message.details;
			if (!d) return undefined;

			function renderOne(d: NotificationDetails): string {
				const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const statusText = isError
					? d.status
					: d.status === "steered"
						? "completed (steered)"
						: "completed";

				// Line 1: icon + agent description + status
				let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

				// Line 2: stats
				const parts: string[] = [];
				if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
				if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
				if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
				if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
				if (parts.length) {
					line += `\n  ${parts.map((p) => theme.fg("dim", p)).join(` ${theme.fg("dim", "·")} `)}`;
				}

				// Line 3: result preview (collapsed) or full (expanded)
				if (expanded) {
					const lines = d.resultPreview.split("\n").slice(0, 30);
					for (const l of lines) line += `\n${theme.fg("dim", `  ${l}`)}`;
				} else {
					const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
					line += `\n  ${theme.fg("dim", `⎿  ${preview}`)}`;
				}

				// Line 4: output file link (if present)
				if (d.outputFile) {
					line += `\n  ${theme.fg("muted", `transcript: ${d.outputFile}`)}`;
				}

				return line;
			}

			const all = [d, ...(d.others ?? [])];
			return new Text(all.map(renderOne).join("\n"), 0, 0);
		},
	);

	/** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
	let loadoutRuntime: ExtensionLifecycleContext | undefined;
	const loadoutResources = new Map<
		string,
		{ readonly fingerprint: string; readonly dispose: () => void; readonly detail?: AgentDetail }
	>();
	const syncLoadoutAgents = (): void => {
		if (!loadoutRuntime || !ownsManagerRegistry) return;
		const current = new Set(getAllTypes());
		for (const [name, resource] of loadoutResources) {
			const config = getAgentConfig(name);
			if (!current.has(name) || !config) {
				resource.dispose();
				loadoutResources.delete(name);
			}
		}
		for (const name of current) {
			const config = getAgentConfig(name);
			if (!config) continue;
			const label = config.displayName ?? config.name;
			// The thinking glyph appears only for a pinned thinking level; an
			// inherited level (frontmatter omits `thinking`) shows no glyph.
			const thinking =
				config.thinking === undefined ? "" : `${hepiThinkingGlyph(config.thinking)} `;
			const summary = `${thinking}${config.model ?? "inherit"}`;
			const projectPrivate = config.source === "project";
			const fingerprint = [
				config.enabled !== false,
				label,
				config.description,
				summary,
				projectPrivate,
				config.model,
				config.thinking,
				config.promptMode,
				config.systemPrompt,
			].join("\0");
			const existing = loadoutResources.get(name);
			if (existing !== undefined && existing.fingerprint === fingerprint) continue;
			existing?.dispose();
			// Keep the same detail instance across fingerprint changes so an open
			// Loadout panel keeps its selection; only the registration is replaced
			// so the list row reflects the reloaded metadata.
			const detail =
				existing?.detail ??
				createAgentDetail(
					pi,
					name,
					config,
					loadoutRuntime?.extension.modelRegistry,
					reloadCustomAgents,
					(message) => loadoutRuntime?.extension.ui.notify(message, "warning"),
				);
			const dispose = registerLoadoutResource(pi, {
				id: `agent:${name}`,
				kind: "agent",
				group: "𖠌 Agents",
				priority: 0,
				conflictSets: [],
				defaultActive: config.enabled !== false,
				label,
				description: config.description,
				summary,
				projectPrivate,
				...(detail === undefined ? {} : { detail }),
				owner: "@hheei/pi-subagents",
			});
			detail?.refresh(config);
			loadoutResources.set(name, { fingerprint, dispose, detail });
		}
	};
	const reloadCustomAgents = () => {
		const userAgents = loadCustomAgents(process.cwd());
		registerAgents(userAgents);
		syncLoadoutAgents();
	};

	// Initial load
	reloadCustomAgents();

	// ---- Agent activity tracking + widget ----
	const agentActivity = new Map<string, AgentActivity>();

	// ---- Cancellable pending notifications ----
	// Holds notifications briefly so get_subagent_result can cancel them
	// before they reach pi.sendMessage (fire-and-forget).
	const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
	const NUDGE_HOLD_MS = 200;
	// A queued result wait must observe completion before its held notification
	// can fire, so successful waits can still suppress that redundant nudge.
	const QUEUE_WAIT_POLL_MS = Math.floor(NUDGE_HOLD_MS / 4);

	function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
		cancelNudge(key);
		pendingNudges.set(
			key,
			setTimeout(() => {
				pendingNudges.delete(key);
				try {
					send();
				} catch {
					/* ignore stale completion side-effect errors */
				}
			}, delay),
		);
	}

	function cancelNudge(key: string) {
		const timer = pendingNudges.get(key);
		if (timer != null) {
			clearTimeout(timer);
			pendingNudges.delete(key);
		}
	}

	// ---- Individual nudge helper (async join mode) ----
	function emitIndividualNudge(record: AgentRecord) {
		if (record.resultConsumed) return; // re-check at send time

		const notification = formatTaskNotification(record, 500);
		const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";

		void Promise.resolve(
			pi.sendMessage<NotificationDetails>(
				{
					customType: "subagent-notification",
					content: notification + footer,
					display: true,
					details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
				},
				{ deliverAs: "followUp", triggerTurn: true },
			),
		).catch(() => undefined);
	}

	function sendIndividualNudge(record: AgentRecord) {
		agentActivity.delete(record.id);
		widget.markFinished(record.id);
		scheduleNudge(record.id, () => emitIndividualNudge(record));
		widget.update();
	}

	// ---- Group join manager ----
	const groupJoin = new GroupJoinManager((records, partial) => {
		for (const r of records) {
			agentActivity.delete(r.id);
			widget.markFinished(r.id);
		}

		const groupKey = `group:${records.map((r) => r.id).join(",")}`;
		scheduleNudge(groupKey, () => {
			// Re-check at send time
			const unconsumed = records.filter((r) => !r.resultConsumed);
			if (unconsumed.length === 0) {
				widget.update();
				return;
			}

			const notifications = unconsumed.map((r) => formatTaskNotification(r, 300)).join("\n\n");
			const label = partial
				? `${unconsumed.length} agent(s) finished (partial — others still running)`
				: `${unconsumed.length} agent(s) finished`;

			const first = unconsumed[0];
			if (first === undefined) return;
			const rest = unconsumed.slice(1);
			const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
			if (rest.length > 0) {
				details.others = rest.map((r) => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
			}

			void Promise.resolve(
				pi.sendMessage<NotificationDetails>(
					{
						customType: "subagent-notification",
						content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
						display: true,
						details,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				),
			).catch(() => undefined);
		});
		widget.update();
	}, 30_000);

	/** Helper: build event data for lifecycle events from an AgentRecord. */
	function buildEventData(record: AgentRecord) {
		const durationMs = record.completedAt
			? record.completedAt - record.startedAt
			: Date.now() - record.startedAt;
		// All three fields are lifetime-accumulated (Σ over every assistant message_end),
		// so they survive compaction together — input + output ≤ total always.
		// tokens is omitted when nothing was ever produced (e.g. agent errored before
		// any message_end fired), preserving prior payload shape.
		const u = record.lifetimeUsage;
		const total = getLifetimeTotal(u);
		const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined;
		return {
			id: record.id,
			type: record.type,
			description: record.description,
			result: record.result,
			error: record.error,
			status: record.status,
			toolUses: record.toolUses,
			durationMs,
			tokens,
		};
	}

	// Background completion: route through group join or send individual nudge
	const manager = new AgentManager(
		(record) => {
			// Disposed records belong to a prior lifecycle. Late completion must not
			// emit events or nudges into replacement session.
			if (manager.getRecord(record.id) !== record) return;
			// Emit lifecycle event based on terminal status
			const isError =
				record.status === "error" || record.status === "stopped" || record.status === "aborted";
			const eventData = buildEventData(record);
			if (isError) {
				pi.events.emit("subagents:failed", eventData);
			} else {
				pi.events.emit("subagents:completed", eventData);
			}

			// Persist final record for cross-extension history reconstruction
			pi.appendEntry("subagents:record", {
				id: record.id,
				type: record.type,
				description: record.description,
				status: record.status,
				result: record.result,
				error: record.error,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
			});

			// Skip notification if result was already consumed via get_subagent_result
			if (record.resultConsumed) {
				agentActivity.delete(record.id);
				widget.markFinished(record.id);
				widget.update();
				return;
			}

			// If this agent is pending batch finalization (debounce window still open),
			// don't send an individual nudge — finalizeBatch will pick it up retroactively.
			if (currentBatchAgents.some((a) => a.id === record.id)) {
				widget.update();
				return;
			}

			const result = groupJoin.onAgentComplete(record);
			if (result === "pass") {
				sendIndividualNudge(record);
			}
			// 'held' → do nothing, group will fire later
			// 'delivered' → group callback already fired
			widget.update();
		},
		undefined,
		(record) => {
			// Emit started event when agent transitions to running (including from queue)
			pi.events.emit("subagents:started", {
				id: record.id,
				type: record.type,
				description: record.description,
			});
			refreshWidget();
		},
		() => {
			refreshWidget();
		},
	);

	getHepiRuntimeSettingsRegistry(pi).replace(createSubagentsSettingsProvider());
	// Direct pi.on handlers cannot be removed on factory replacement. Token
	// ownership makes stale handlers inert once newer root activation claims slot.
	const activationToken = { active: true };
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-subagents",
		start: async (runtime) => {
			// Resolve process-wide ownership only after ext-core has awaited any
			// replacement lifecycle cleanup. This lets a true reload replace a
			// disposed manager while child activations still share the root owner.
			const currentEntry = runtimeGlobal[MANAGER_KEY] as
				| {
						readonly disposed?: boolean;
						readonly activationToken?: { active: boolean };
				  }
				| undefined;
			ownsManagerRegistry =
				currentEntry === registryEntry ||
				currentEntry === undefined ||
				currentEntry.disposed === true;
			if (ownsManagerRegistry) {
				if (currentEntry !== registryEntry && currentEntry?.activationToken)
					currentEntry.activationToken.active = false;
				activationToken.active = true;
				registryEntry.disposed = false;
				runtimeGlobal[MANAGER_KEY] = registryEntry;
			} else {
				activationToken.active = false;
			}
			if (ownsManagerRegistry) {
				loadoutRuntime = runtime;
				runtime.resources.add("loadout-agents", () => {
					for (const resource of loadoutResources.values()) resource.dispose();
					loadoutResources.clear();
				});
				runtime.resources.add("loadout-agent-runtime", () => {
					loadoutRuntime = undefined;
					setLoadoutActivation(undefined);
				});
				observeLoadoutToolActivation(pi, {
					signal: runtime.signal,
					onChange: (snapshot) => {
						setLoadoutActivation(snapshot);
						agentTool.description = resolveAgentToolDescription();
					},
				});
				syncLoadoutAgents();
			}
			const sessionId = runtime.extension.sessionManager?.getSessionId?.();
			if (sessionId === undefined)
				throw new Error("Pi session id is required for subagent settings");
			// Only the activation that claimed the process-wide manager registry is
			// allowed to own editor-adjacent UI. Child activations share the same
			// process but deliberately leave this registry slot untouched.
			if (ownsManagerRegistry && runtime.extension.mode === "tui") {
				const widgetHandle = registerHepiWidget(pi, runtime.extension, runtime.signal, {
					id: "pi-subagents:agents",
					placement: "aboveEditor",
					visible: false,
					create: (_tui, theme) => widget.createComponent(theme),
				});
				widget.setStatusCallback((text) => runtime.extension.ui.setStatus("subagents", text));
				widget.setRegistration(widgetHandle);
				runtime.resources.add("pi-subagents-widget", () => {
					widget.dispose();
				});
			}
			await applyAndEmitLoaded(
				{
					setMaxConcurrent: (value) => manager.setMaxConcurrent(value),
					setDefaultMaxTurns,
					setGraceTurns,
					setDefaultJoinMode,
					setSchedulingEnabled,
					setScopeModels: setScopeModelsEnabled,
					setDisableDefaultAgents,
					setToolDescriptionMode,
					setWidgetMode,
					setOutputTranscript,
				},
				(event, payload) => pi.events.emit(event, payload),
				{ sessionId, cwd: runtime.extension.cwd, signal: runtime.signal },
			);
			agentTool.description = resolveAgentToolDescription();
			configureSubagentCoordinator(runtime, {
				...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
				maxActiveTurns: manager.getMaxConcurrent(),
			});
			manager.setRuntime(runtime);
			runtime.resources.add("pi-subagents-manager", () => {
				activationToken.active = false;
				registryEntry.disposed = true;
				manager.dispose();
			});
		},
	});

	// Expose manager via Symbol.for() global registry for cross-package access.
	// Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
	//
	// Lifecycle start claims this slot only when free or marked disposed. Child
	// sessions re-activate this extension in the same process and leave the
	// active root manager untouched; a replacement can claim after cleanup.
	const MANAGER_KEY = Symbol.for("pi-subagents:manager");
	const registryEntry = {
		disposed: false,
		activationToken,
		waitForAll: () => manager.waitForAll(),
		hasRunning: () => manager.hasRunning(),
		spawn: (
			piRef: ExtensionAPI,
			ctx: ExtensionContext,
			type: SubagentType,
			prompt: string,
			options: SpawnOptions,
		) => manager.spawn(piRef, ctx, type, prompt, options),
		getRecord: (id: string) => manager.getRecord(id),
	};
	const runtimeGlobal = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
	let ownsManagerRegistry = false;
	const isActive = (): boolean =>
		ownsManagerRegistry &&
		runtimeGlobal[MANAGER_KEY] === registryEntry &&
		activationToken.active &&
		!registryEntry.disposed;
	const refreshWidget = (): void => {
		widget.ensureTimer();
		widget.update();
	};

	// --- Cross-extension RPC via pi.events ---
	let currentCtx: ExtensionContext | undefined;
	let fleetSurfaceController = new AbortController();
	// RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
	// (a bound lifecycle event), not at factory time. pi runs every extension
	// factory before the `extensions:` filter and only fires lifecycle events for
	// survivors, so a child session that filtered pi-subagents out never reaches
	// session_start — and must not advertise or answer RPC it can't service
	// (currentCtx would stay undefined → spawn always "No active session"). Gating
	// here makes a filtered session behave like an absent one (#142).
	let rpcHandle: RpcHandle | undefined;

	// ---- Subagent scheduler ----
	// Session-scoped: store is constructed inside session_start once sessionId
	// is available. Mirrors pi-chonky-tasks's session-scoped task store —
	// schedules reset on /new, restore on /resume.
	const scheduler = new SubagentScheduler();

	function startScheduler(ctx: ExtensionContext) {
		try {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			if (!sessionId) return; // sessionId not yet available — try again on next event
			const path = resolveStorePath(ctx.cwd, sessionId);
			const store = new ScheduleStore(path);
			scheduler.start(pi, ctx, manager, store);
			pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
		} catch (err) {
			// Scheduling is non-essential — log and move on so the rest of the
			// extension keeps working if e.g. .pi/ is unwritable.
			console.warn("[pi-subagents] Failed to start scheduler:", err);
		}
	}

	// Capture ctx from session_start for RPC spawn handler + start the scheduler.
	// This also wires the RPC handlers and broadcasts readiness — on the first
	// bound session_start, so a filtered-out activation never advertises (#142).
	pi.on("session_start", async (_event, ctx) => {
		if (!isActive()) return;
		fleetSurfaceController.abort();
		fleetSurfaceController = new AbortController();
		currentCtx = ctx;
		manager.clearCompleted(true);
		// Guard mirrors the `!scheduler.isActive()` pattern below: session_start
		// fires once per activation, but a double-bind must not leak listeners.
		if (!rpcHandle) {
			rpcHandle = registerRpcHandlers({
				events: pi.events,
				pi,
				getCtx: () => currentCtx,
				manager,
			});
			// Broadcast readiness so extensions loaded alongside us can discover us.
			// Emitting after all factories have run (rather than at factory time)
			// also avoids the race where a consumer loaded after us misses the event.
			pi.events.emit("subagents:ready", {});
		}
		if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
	});

	pi.on("session_before_switch", () => {
		if (!isActive()) return;
		currentCtx = undefined;
		manager.abortAll();
		manager.dispose();
		scheduler.stop();
	});

	// On shutdown, abort all agents immediately and clean up. ext-core runs its
	// lifecycle resource cleanup first, which marks this entry disposed and
	// deactivates its token. Registry identity remains the ownership signal here:
	// stale reload handlers and child activations must stay inert.
	// If the session is going down, there's nothing left to consume agent results.
	pi.on("session_shutdown", async () => {
		if (!ownsManagerRegistry || runtimeGlobal[MANAGER_KEY] !== registryEntry) return;
		activationToken.active = false;
		fleetSurfaceController.abort();
		rpcHandle?.unsubSpawn();
		rpcHandle?.unsubStop();
		rpcHandle?.unsubPing();
		rpcHandle = undefined;
		currentCtx = undefined;
		// Only release the global slot if this activation claimed it — a child
		// session's shutdown must not delete the root session's registry entry.
		if (ownsManagerRegistry && runtimeGlobal[MANAGER_KEY] === registryEntry) {
			delete runtimeGlobal[MANAGER_KEY];
		}
		scheduler.stop();
		manager.abortAll();
		for (const timer of pendingNudges.values()) clearTimeout(timer);
		pendingNudges.clear();
		manager.dispose();
	});

	// Persisted schedules outlive the removed Fleet menu. Keep management small
	// and scriptable: list jobs, or remove one by ID.
	pi.registerCommand("subagent-schedules", {
		description: "List or remove persisted subagent schedules",
		getArgumentCompletions: (prefix) =>
			["list", "remove", "cancel"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!scheduler.isActive()) {
				ctx.ui.notify("Scheduler is not active in this session.", "warning");
				return;
			}
			const [operation = "list", id] = args.trim().split(/\s+/, 2);
			if (operation === "list") {
				const jobs = scheduler.list();
				ctx.ui.notify(
					jobs.length === 0
						? "No scheduled subagent jobs."
						: jobs
								.map((job) => {
									const next = scheduler.getNextRun(job.id) ?? "not armed";
									return `${job.id}  ${job.name}  ${job.schedule}  ${job.enabled ? "enabled" : "disabled"}  next: ${next}`;
								})
								.join("\n"),
					"info",
				);
				return;
			}
			if ((operation === "remove" || operation === "cancel") && id) {
				const removed = scheduler.removeJob(id);
				ctx.ui.notify(
					removed
						? `Removed scheduled subagent job ${id}.`
						: `Scheduled subagent job not found: ${id}`,
					removed ? "info" : "warning",
				);
				return;
			}
			ctx.ui.notify("Usage: /subagent-schedules [list|remove <job-id>]", "warning");
		},
	});

	// Live widget: show running agents above editor.
	// widgetMode (default "background") selects what the widget shows: "all" =
	// every agent; "background" = hide foreground (they already render inline as
	// the Agent tool result, so showing them here too is a duplicate, #118), keep
	// everything else; "off" = hide the widget entirely. Read live at render time.
	let widgetMode: WidgetMode = "background";
	function getWidgetMode(): WidgetMode {
		return widgetMode;
	}
	const widget = new AgentWidget(manager, agentActivity, getWidgetMode);
	function setWidgetMode(m: WidgetMode): void {
		widgetMode = m;
		widget.update();
	}

	// Project/global default for writing the subagent .output transcript. A custom
	// agent's `output_transcript` frontmatter overrides this per spawn; when the
	// frontmatter is silent, this default applies. Read live at spawn time.
	let outputTranscriptDefault = true;
	function getOutputTranscriptDefault(): boolean {
		return outputTranscriptDefault;
	}
	function setOutputTranscript(b: boolean): void {
		outputTranscriptDefault = b;
	}

	// ---- Join mode configuration ----
	let defaultJoinMode: JoinMode = "smart";
	function setDefaultJoinMode(mode: JoinMode) {
		defaultJoinMode = mode;
	}

	// Master switch for the schedule subagent feature. Defaults to enabled.
	// Read once at extension init (before tool registration) so the Agent tool's
	// parameter schema reflects the persisted setting. Changes apply on the next
	// extension load; execute-time admission still reads this value immediately.
	let schedulingEnabled = true;
	function isSchedulingEnabled(): boolean {
		return schedulingEnabled;
	}
	function setSchedulingEnabled(b: boolean) {
		schedulingEnabled = b;
	}

	// ---- Scope models configuration ----
	// When enabled, subagent model choices are validated against `enabledModels`
	// from pi's settings — both global `<agentDir>/settings.json` and
	// project-local `<cwd>/.pi/settings.json` (project overrides global).
	// Off by default; opt-in through Settings. See docstring on
	// SubagentsSettings.scopeModels for the hard-error vs warn-and-proceed
	// policy and its rationale.
	let scopeModelsEnabled = false;
	function isScopeModelsEnabled(): boolean {
		return scopeModelsEnabled;
	}
	function setScopeModelsEnabled(enabled: boolean): void {
		scopeModelsEnabled = enabled;
	}

	// ---- Disable default agents configuration ----
	// When enabled, the three hardcoded default agents (general-purpose, Explore,
	// Plan) are not registered. User-defined agents from project/global custom
	// agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
	// Defaults to false; configured through Settings or subagents.json.
	// State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
	// needs it; this wrapper just re-registers after flipping it.
	function setDisableDefaultAgents(b: boolean): void {
		setDefaultsDisabled(b);
		reloadCustomAgents(); // re-register with new setting
	}

	// ---- Agent tool description mode ----
	// "full" (default) keeps the rich Claude Code-style description; "compact"
	// swaps in a ~75% smaller one for small/local models (#91). Read once at
	// tool registration — flipping it applies on the next pi session.
	let toolDescriptionMode: ToolDescriptionMode = "full";
	function getToolDescriptionMode(): ToolDescriptionMode {
		return toolDescriptionMode;
	}
	function setToolDescriptionMode(mode: ToolDescriptionMode): void {
		toolDescriptionMode = mode;
	}

	// ---- Batch tracking for smart join mode ----
	// Collects background agent IDs spawned in the current turn for smart grouping.
	// Uses a debounced timer: each new agent resets the 100ms window so that all
	// parallel tool calls (which may be dispatched across multiple microtasks by the
	// framework) are captured in the same batch.
	let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
	let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
	let batchCounter = 0;

	/** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
	function finalizeBatch() {
		batchFinalizeTimer = undefined;
		const batchAgents = [...currentBatchAgents];
		currentBatchAgents = [];

		const smartAgents = batchAgents.filter((a) => a.joinMode === "smart" || a.joinMode === "group");
		if (smartAgents.length >= 2) {
			const groupId = `batch-${++batchCounter}`;
			const ids = smartAgents.map((a) => a.id);
			groupJoin.registerGroup(groupId, ids);
			// Retroactively process agents that already completed during the debounce window.
			// Their onComplete fired but was deferred (agent was in currentBatchAgents),
			// so we feed them into the group now.
			for (const id of ids) {
				const record = manager.getRecord(id);
				if (!record) continue;
				record.groupId = groupId;
				if (record.completedAt != null && !record.resultConsumed) {
					groupJoin.onAgentComplete(record);
				}
			}
		} else {
			// No group formed — send individual nudges for any agents that completed
			// during the debounce window and had their notification deferred.
			for (const { id } of batchAgents) {
				const record = manager.getRecord(id);
				if (record?.completedAt != null && !record.resultConsumed) {
					sendIndividualNudge(record);
				}
			}
		}
	}

	// Clear lingering widget state on new turn.
	pi.on("tool_execution_start", async (_event, _ctx) => {
		widget.onTurnStart();
	});

	/** Format an agent's tool scope: "*" when it has all built-ins, else a comma-separated list. */
	const formatToolsSuffix = (cfg: AgentConfig | undefined): string => {
		const tools = cfg?.builtinToolNames;
		if (!tools || tools.length === 0) return "*";
		const isFullSet =
			tools.length === BUILTIN_TOOL_NAMES.length &&
			BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
		return isFullSet ? "*" : tools.join(", ");
	};

	/** Build the full type list text dynamically from available agents only. */
	const buildTypeListText = () => {
		const available = getAvailableTypes();

		return available
			.map((name) => {
				const cfg = getAgentConfig(name);
				if (cfg === undefined) return `- ${name}: ${name}`;
				const modelSuffix = cfg.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
				const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
				return `- ${name}: ${cfg.description}${modelSuffix}${toolsSuffix}`;
			})
			.join("\n");
	};

	/** First sentence of an agent description — for the compact type list. */
	const firstSentence = (text: string): string => {
		const match = text.match(/^.*?[.!?](?=\s|$)/s);
		return (match ? match[0] : text).replace(/\s+/g, " ").trim();
	};

	/** Compact type list: one line per agent, first sentence only. */
	const buildCompactTypeListText = () =>
		getAvailableTypes()
			.map((name) => {
				const cfg = getAgentConfig(name);
				if (cfg === undefined) return `- ${name}: ${name}`;
				return `- ${name}: ${firstSentence(cfg.description)} (Tools: ${formatToolsSuffix(cfg)})`;
			})
			.join("\n");

	/** Derive a short model label from a model string. */
	function getModelLabelFromConfig(model: string): string {
		// Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
		const name = model.includes("/") ? (model.split("/").pop() ?? model) : model;
		// Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
		return name.replace(/-\d{8}$/, "");
	}

	// ---- Agent tool ----

	// Schedule param + its guideline are gated on `schedulingEnabled` (read once
	// at registration; flipping the setting later requires next pi session for
	// the schema to update). Defining the shape once and spreading it via Partial
	// preserves Type.Object's inference when present and produces a
	// `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
	const scheduleParamShape = {
		schedule: Type.Optional(
			Type.String({
				description:
					"Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). " +
					'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
					"Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.",
			}),
		),
	};
	const scheduleParam: Partial<typeof scheduleParamShape> = isSchedulingEnabled()
		? scheduleParamShape
		: {};

	const scheduleGuideline = isSchedulingEnabled()
		? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
		: "";

	// Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
	// the same load-bearing facts as the full version at ~75% fewer tokens, for
	// small/local models. Per-option details live in the param descriptions.
	const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls, run_in_background: true on each. You are notified when background agents finish — never poll or sleep.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.
- isolation: "worktree" runs the agent in an isolated git worktree; changes land on a branch.`;

	const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls. Foreground calls run sequentially — only one executes at a time.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use run_in_background for work you don't need immediately. You will be notified when it completes — do NOT poll or sleep waiting for it. Continue with other work or respond to the user instead.
- Foreground vs background: use foreground (default) when you need the agent's results before you can proceed. Use background when you have genuinely independent work to do in parallel.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.${scheduleGuideline}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

	// `toolDescriptionMode: "custom"` — user-authored description with live
	// dynamic parts. Project file wins over global; missing/empty falls back to
	// "full" (a stale fallback beats a blank tool description). Only the prose
	// is customizable — the parameter schema stays code-owned.
	const renderToolDescriptionTemplate = (template: string): string => {
		const vars: Record<string, () => string> = {
			typeList: buildTypeListText,
			compactTypeList: buildCompactTypeListText,
			agentDir: getAgentDir,
			scheduleGuideline: () => scheduleGuideline,
		};
		// Replacement callback (not a string) — agent descriptions may contain `$&` etc.
		return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
			if (vars[name]) return vars[name]();
			console.warn(
				`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`,
			);
			return raw;
		});
	};

	const loadCustomToolDescription = (): string | undefined => {
		for (const path of [
			join(process.cwd(), ".pi", "agent-tool-description.md"),
			join(getAgentDir(), "agent-tool-description.md"),
		]) {
			try {
				if (!existsSync(path)) continue;
				const text = readFileSync(path, "utf-8").trim();
				if (text) return renderToolDescriptionTemplate(text);
				console.warn(`[pi-subagents] ${path} is empty — ignoring`);
			} catch (err) {
				console.warn(
					`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		return undefined;
	};

	const resolveAgentToolDescription = (): string => {
		const mode = getToolDescriptionMode();
		if (mode === "compact") return compactAgentToolDescription;
		if (mode === "custom") {
			const custom = loadCustomToolDescription();
			if (custom) return custom;
			console.warn(
				'[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"',
			);
		}
		return fullAgentToolDescription;
	};
	const agentToolDescription = resolveAgentToolDescription();

	const agentTool = defineTool({
		name: SUBAGENT_TOOL_NAMES.AGENT,
		label: "Agent",
		description: agentToolDescription,
		promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
		promptGuidelines: [
			"Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
			"For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
			"When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
			"Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description: "The task for the agent to perform.",
			}),
			description: Type.String({
				description: "A short (3-5 word) description of the task (shown in UI).",
			}),
			subagent_type: Type.String({
				description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
			}),
			model: Type.Optional(
				Type.String({
					description:
						'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
				}),
			),
			max_turns: Type.Integer({
				description: "Maximum number of agentic turns before the fixed five-turn wrap-up grace.",
				minimum: 1,
			}),
			run_in_background: Type.Optional(
				Type.Boolean({
					description:
						"Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description: "Optional agent ID to resume from. Continues from previous context.",
				}),
			),
			isolated: Type.Optional(
				Type.Boolean({
					description: "If true, agent gets no extension/MCP tools — only built-in tools.",
				}),
			),
			inherit_context: Type.Optional(
				Type.Boolean({
					description:
						"If true, fork parent conversation into the agent. Default: false (fresh context).",
				}),
			),
			isolation: Type.Optional(
				Type.Literal("worktree", {
					description:
						'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Changes are saved to a branch on completion.',
				}),
			),
			...scheduleParam,
		}),

		// ---- Custom rendering: Claude Code style ----

		renderCall(args, theme) {
			const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
			const desc = args.description ?? "";
			return new Text(
				"▸ " +
					theme.fg("toolTitle", theme.bold(displayName)) +
					(desc ? `  ${theme.fg("muted", desc)}` : ""),
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as AgentDetails | undefined;
			if (!details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			}

			// Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
			const stats = (d: AgentDetails) => {
				const parts: string[] = [];
				if (d.modelName) parts.push(d.modelName);
				if (d.tags) parts.push(...d.tags);
				if (d.turnCount != null && d.turnCount > 0) {
					parts.push(formatTurns(d.turnCount, d.maxTurns));
				}
				if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
				if (d.tokens) parts.push(d.tokens);
				return parts
					.map((p) => fgPreservingNestedStyles(theme, "dim", p))
					.join(` ${theme.fg("dim", "·")} `);
			};

			// ---- While running (streaming) ----
			if (isPartial || details.status === "running") {
				const frame = SPINNER[details.spinnerFrame ?? 0] ?? SPINNER[0] ?? "";
				const s = stats(details);
				return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
			}

			// ---- Background agent launched ----
			if (details.status === "background") {
				return new Text(
					theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`),
					0,
					0,
				);
			}

			// ---- Completed / Steered ----
			if (details.status === "completed" || details.status === "steered") {
				const duration = formatMs(details.durationMs);
				const isSteered = details.status === "steered";
				const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
				const s = stats(details);
				let line = icon + (s ? ` ${s}` : "");
				line += ` ${theme.fg("dim", "·")} ${theme.fg("dim", duration)}`;

				if (expanded) {
					const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
					if (resultText) {
						const lines = resultText.split("\n").slice(0, 50);
						for (const l of lines) {
							line += `\n${theme.fg("dim", `  ${l}`)}`;
						}
						if (resultText.split("\n").length > 50) {
							line +=
								"\n" +
								theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
						}
					}
				} else {
					const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
					line += `\n${theme.fg("dim", `  ⎿  ${doneText}`)}`;
				}
				return new Text(line, 0, 0);
			}

			// ---- Stopped (user-initiated abort) ----
			if (details.status === "stopped") {
				const s = stats(details);
				let line = theme.fg("dim", "■") + (s ? ` ${s}` : "");
				line += `\n${theme.fg("dim", "  ⎿  Stopped")}`;
				return new Text(line, 0, 0);
			}

			// ---- Error / Aborted (hard max_turns) ----
			const s = stats(details);
			let line = theme.fg("error", "✗") + (s ? ` ${s}` : "");

			if (details.status === "error") {
				line += `\n${theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`)}`;
			} else {
				line += `\n${theme.fg("warning", "  ⎿  Aborted (max turns exceeded)")}`;
			}

			return new Text(line, 0, 0);
		},

		// ---- Execute ----

		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			// Reload custom agents so new project/global .md files are picked up without restart
			reloadCustomAgents();

			const rawType = params.subagent_type as SubagentType;
			const resolved = resolveType(rawType);
			if (resolved !== undefined && isLoadoutResourceDisabled(resolved)) {
				return textResult(`Agent type "${rawType}" is disabled by Loadout.`);
			}
			const subagentType = resolved ?? "general-purpose";
			const fellBack = resolved === undefined;

			const displayName = getDisplayName(subagentType);

			// Get agent config (if any)
			const customConfig = getAgentConfig(subagentType);

			const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

			// Resolve model from agent config first; tool-call params only fill gaps.
			let model = ctx.model;
			if (resolvedConfig.modelInput) {
				const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
				if (typeof resolved === "string") {
					if (resolvedConfig.modelFromParams) return textResult(resolved);
					// config-specified: silent fallback to parent
				} else {
					model = resolved;
				}
			}

			// Scope validation: the effective resolved model is checked against the
			// user's enabledModels list (read in `enabled-models.ts`).
			//
			// Design: scopeModels guards against *runtime* LLM choices, not user-level config.
			//   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
			//     out-of-scope choice; surface it so it picks differently).
			//   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
			//     user authored/installed this agent or chose the parent's model; trust it).
			// See SubagentsSettings.scopeModels docstring for the full policy.
			if (isScopeModelsEnabled() && model) {
				const allowed = resolveEnabledModels(
					readEnabledModels(ctx.cwd),
					ctx.modelRegistry,
					ctx.cwd,
				);
				if (allowed && !isModelInScope(model, allowed)) {
					if (resolvedConfig.modelFromParams) {
						const list = [...allowed]
							.sort()
							.map((m) => `  ${m}`)
							.join("\n");
						return textResult(
							`Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
								`Allowed models (from enabledModels):\n${list}`,
						);
					}
					// Frontmatter-pinned or parent-inherited: warn + proceed.
					const agentLabel = customConfig?.displayName ?? subagentType;
					const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
					ctx.ui.notify(
						`Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
						"warning",
					);
				}
			}

			const thinking = resolvedConfig.thinking;
			const inheritContext = resolvedConfig.inheritContext;
			const runInBackground = resolvedConfig.runInBackground;
			const isolated = resolvedConfig.isolated;
			const isolation = resolvedConfig.isolation;
			// Whether this spawn writes its .output transcript. Per-agent
			// frontmatter (`output_transcript`) wins; otherwise the project/global
			// default applies. `attachTranscript` below is the SOLE gate — every
			// downstream consumer keys off record.outputFile being set, so no spawn
			// path can re-enable the transcript by accident.
			const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
			const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
				if (!rec || !outputTranscript) return;
				rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
				writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
			};

			const parentModelId = ctx.model?.id;
			const effectiveModelId = model?.id;
			const modelName =
				effectiveModelId && effectiveModelId !== parentModelId
					? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
					: undefined;
			const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? params.max_turns);
			const configuredMaxTurns = resolvedConfig.maxTurns;
			const agentInvocation: AgentInvocation = {
				...(modelName === undefined ? {} : { modelName }),
				...(thinking === undefined ? {} : { thinking }),
				// Explicit value only — the default fallback would just add noise.
				...(configuredMaxTurns === undefined
					? {}
					: { maxTurns: normalizeMaxTurns(configuredMaxTurns) }),
				isolated,
				inheritContext,
				runInBackground,
				...(isolation === undefined ? {} : { isolation }),
			};
			// Tool-result render shows the mode label too; viewer's header already does.
			const modeLabel = getPromptModeLabel(subagentType);
			const { tags: invocationTags } = buildInvocationTags(agentInvocation);
			const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
			const detailBase = {
				displayName,
				description: params.description,
				subagentType,
				...(modelName === undefined ? {} : { modelName }),
				...(agentTags.length > 0 ? { tags: agentTags } : {}),
			};

			// ---- Schedule: register a job, don't spawn now ----
			if (params.schedule) {
				if (!isSchedulingEnabled()) {
					return textResult(
						"Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.",
					);
				}
				if (params.resume) {
					return textResult(
						"Cannot combine `schedule` with `resume` — schedules create fresh agents.",
					);
				}
				if (params.inherit_context) {
					return textResult(
						"Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.",
					);
				}
				if (params.run_in_background === false) {
					return textResult(
						"Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.",
					);
				}
				if (!scheduler.isActive()) {
					return textResult(
						"Scheduler is not active in this session yet. Try again after the session has fully started.",
					);
				}
				try {
					const job = scheduler.addJob({
						name: params.description as string,
						description: params.description as string,
						schedule: params.schedule as string,
						subagent_type: subagentType,
						prompt: params.prompt as string,
						...(params.model === undefined ? {} : { model: params.model as string }),
						...(thinking === undefined ? {} : { thinking }),
						max_turns: effectiveMaxTurns,
						isolated: isolated,
						...(isolation === undefined ? {} : { isolation }),
					});
					const next = scheduler.getNextRun(job.id);
					return textResult(
						`Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
							`Next run: ${next ?? "(unknown)"}. ` +
							`Manage via /subagent-schedules list or /subagent-schedules remove ${job.id}.`,
					);
				} catch (err) {
					return textResult(err instanceof Error ? err.message : String(err));
				}
			}

			// Resume existing agent
			if (params.resume) {
				const existing = manager.getRecord(params.resume);
				if (!existing) {
					return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
				}
				if (!existing.handle) {
					return textResult(`Agent "${params.resume}" has no active session to resume.`);
				}
				const record = await manager.resume(params.resume, params.prompt, signal);
				if (!record) {
					return textResult(`Failed to resume agent "${params.resume}".`);
				}
				// A failed resume surfaces the error, plus any partial output THIS
				// resume produced (never the previous turn's answer, #144).
				if (record.status === "error") {
					return textResult(
						`Agent failed: ${record.error}${partialOutputSuffix(record)}`,
						buildDetails(detailBase, record),
					);
				}
				return textResult(record.result?.trim() || "No output.", buildDetails(detailBase, record));
			}

			// Background execution
			if (runInBackground) {
				const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

				// Wrap onSessionCreated to wire output file streaming.
				// The callback lazily reads record.outputFile (set right after spawn)
				// rather than closing over a value that doesn't exist yet.
				let id: string;
				const origBgOnSession = bgCallbacks.onSessionCreated;
				bgCallbacks.onSessionCreated = (session: ConversationSubagentHandle) => {
					origBgOnSession(session);
					const rec = manager.getRecord(id);
					if (rec?.outputFile) {
						rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
					}
				};

				try {
					id = manager.spawn(pi, ctx, subagentType, params.prompt, {
						description: params.description,
						...(model === undefined ? {} : { model }),
						maxTurns: effectiveMaxTurns,
						isolated,
						inheritContext,
						...(thinking === undefined ? {} : { thinkingLevel: thinking }),
						isBackground: true,
						...(isolation === undefined ? {} : { isolation }),
						invocation: agentInvocation,
						...bgCallbacks,
					});
				} catch (err) {
					return textResult(err instanceof Error ? err.message : String(err));
				}

				// Set output file + join mode synchronously after spawn, before the
				// event loop yields — onSessionCreated is async so this is safe.
				const joinMode = resolveJoinMode(defaultJoinMode, true);
				const record = manager.getRecord(id);
				if (record && joinMode) {
					record.joinMode = joinMode;
					record.toolCallId = toolCallId;
					attachTranscript(record, id);
				}

				if (joinMode == null || joinMode === "async") {
					// Foreground/no join mode or explicit async — not part of any batch
				} else {
					// smart or group — add to current batch
					currentBatchAgents.push({ id, joinMode });
					// Debounce: reset timer on each new agent so parallel tool calls
					// dispatched across multiple event loop ticks are captured together
					if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
					batchFinalizeTimer = setTimeout(finalizeBatch, 100);
				}

				agentActivity.set(id, bgState);
				refreshWidget();

				// Emit created event
				pi.events.emit("subagents:created", {
					id,
					type: subagentType,
					description: params.description,
					isBackground: true,
				});

				const isQueued = record?.status === "queued";
				return textResult(
					`Agent ${isQueued ? "queued" : "started"} in background.\n` +
						`Agent ID: ${id}\n` +
						`Type: ${displayName}\n` +
						`Description: ${params.description}\n` +
						(record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
						(isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
						`\nYou will be notified when this agent completes.\n` +
						`Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
						`Do not duplicate this agent's work.`,
					{
						...detailBase,
						toolUses: 0,
						tokens: "",
						durationMs: 0,
						status: "background" as const,
						agentId: id,
					},
				);
			}

			// Foreground (synchronous) execution — stream progress via onUpdate
			let spinnerFrame = 0;
			const startedAt = Date.now();
			let fgId: string | undefined;

			const streamUpdate = () => {
				const details: AgentDetails = {
					...detailBase,
					toolUses: fgState.toolUses,
					tokens: formatLifetimeTokens(fgState),
					turnCount: fgState.turnCount,
					...(fgState.maxTurns === undefined ? {} : { maxTurns: fgState.maxTurns }),
					durationMs: Date.now() - startedAt,
					status: "running",
					activity: describeActivity(fgState.activeTools, fgState.responseText),
					spinnerFrame: spinnerFrame % SPINNER.length,
				};
				onUpdate?.({
					content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
					details,
				});
			};

			const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(
				effectiveMaxTurns,
				streamUpdate,
			);

			// Wire session creation: register in widget + stream to output file.
			// The output file path is set synchronously after spawn (below),
			// before onSessionCreated fires — same pattern as background agents.
			const origOnSession = fgCallbacks.onSessionCreated;
			fgCallbacks.onSessionCreated = (session: ConversationSubagentHandle) => {
				origOnSession(session);
				for (const a of manager.listAgents()) {
					if (a.handle === session) {
						fgId = a.id;
						agentActivity.set(a.id, fgState);
						refreshWidget();
						break;
					}
				}
				// Stream conversation to output file (foreground agent logging)
				if (fgId) {
					const rec = manager.getRecord(fgId);
					if (rec?.outputFile) {
						rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
					}
				}
			};

			// Animate spinner at ~80ms (smooth rotation through 10 braille frames)
			const spinnerInterval = setInterval(() => {
				spinnerFrame++;
				streamUpdate();
			}, 80);

			streamUpdate();

			let record: AgentRecord;
			try {
				const fgResult = await manager.spawnAndWait(
					pi,
					ctx,
					subagentType,
					params.prompt,
					{
						description: params.description,
						...(model === undefined ? {} : { model }),
						maxTurns: effectiveMaxTurns,
						isolated,
						inheritContext,
						...(thinking === undefined ? {} : { thinkingLevel: thinking }),
						...(isolation === undefined ? {} : { isolation }),
						invocation: agentInvocation,
						...(signal === undefined ? {} : { signal }),
						...fgCallbacks,
					},
					(fgAgentId) => {
						// onSpawned: called synchronously after spawn, before onSessionCreated fires.
						// Set up the output file so streamToOutputFile can pick it up.
						const fgRec = manager.getRecord(fgAgentId);
						attachTranscript(fgRec, fgAgentId);
					},
				);
				record = fgResult.record;
			} catch (err) {
				clearInterval(spinnerInterval);
				return textResult(err instanceof Error ? err.message : String(err));
			}

			clearInterval(spinnerInterval);

			// Clean up foreground agent from widget
			if (fgId) {
				agentActivity.delete(fgId);
				widget.markFinished(fgId);
			}

			// Get final token count
			const tokenText = formatLifetimeTokens(fgState);

			const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });

			// "general-purpose" may itself be unregistered (defaults disabled, no
			// user override) — getConfig then uses the hardcoded fallback config.
			const fallbackNote = fellBack
				? `Note: Unknown agent type "${rawType}" — using ${resolveType("general-purpose") ? "general-purpose" : "the fallback agent config"}.\n\n`
				: "";

			if (record.status === "error") {
				// Error headline + any partial output the run produced before failing.
				return textResult(
					`${fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`,
					details,
				);
			}

			const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
			const statsParts = [`${record.toolUses} tool uses`];
			if (tokenText) statsParts.push(tokenText);
			return textResult(
				`${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
					(record.result?.trim() || "No output."),
				details,
			);
		},
	});
	pi.registerTool(agentTool);

	// ---- get_subagent_result tool ----

	pi.registerTool(
		defineTool({
			name: SUBAGENT_TOOL_NAMES.GET_RESULT,
			label: "Get Agent Result",
			description:
				"Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
			promptSnippet: "Check status and retrieve results from a background agent",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to check.",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description:
							"If true, wait for the agent to complete before returning. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
				const record = manager.getRecord(params.agent_id);
				if (!record) {
					return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
				}

				// Wait for completion if requested. Cancellation stops only this tool
				// call; the background agent keeps running and remains unconsumed so its
				// completion notification can still be delivered.
				// Queued agents have no promise yet (it's created when the queue starts
				// them), so poll until they leave the queue, then await like a running one.
				if (params.wait && (record.status === "running" || record.status === "queued")) {
					while (record.status === "queued") {
						await abortable(
							new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
							signal,
						);
					}
					if (record.promise) await abortable(record.promise, signal);
				}

				const displayName = getDisplayName(record.type);
				const duration = formatDuration(record.startedAt, record.completedAt);
				const tokens = formatLifetimeTokens(record);
				const contextPercent = record.contextPercent ?? null;
				const statsParts = [`Tool uses: ${record.toolUses}`];
				if (tokens) statsParts.push(tokens);
				if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
				if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
				statsParts.push(`Duration: ${duration}`);

				let output =
					`Agent: ${record.id}\n` +
					`Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
					`Description: ${record.description}\n\n`;

				if (record.status === "running") {
					output += "Agent is still running. Use wait: true or check back later.";
				} else if (record.status === "error") {
					output += `Error: ${record.error}${partialOutputSuffix(record)}`;
				} else {
					output += record.result?.trim() || "No output.";
				}

				// Mark result as consumed — suppresses the completion notification
				if (record.status !== "running" && record.status !== "queued") {
					record.resultConsumed = true;
					cancelNudge(params.agent_id);
				}

				// Verbose: include full conversation
				if (params.verbose && record.handle) {
					const snapshot = record.handle.transcript();
					const conversation = snapshot.entries
						.map((entry) => {
							if (entry.role === "assistant") return `Assistant: ${entry.text}`;
							if (entry.role === "user") return `User: ${entry.text}`;
							return `Tool (${entry.toolName}): ${entry.text}`;
						})
						.join("\n\n");
					output += `\n\n--- Agent Conversation ---\n${conversation}${snapshot.truncated ? "\n\n...(truncated)" : ""}`;
				}

				return textResult(output);
			},
		}),
	);

	// ---- steer_subagent tool ----

	pi.registerTool(
		defineTool({
			name: SUBAGENT_TOOL_NAMES.STEER,
			label: "Steer Agent",
			description:
				"Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
				"and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
			promptSnippet: "Send a steering message to redirect a running background agent",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to steer (must be currently running).",
				}),
				message: Type.String({
					description:
						"The steering message to send. This will appear as a user message in the agent's conversation.",
				}),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
				const record = manager.getRecord(params.agent_id);
				if (!record) {
					return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
				}
				if (record.status !== "running") {
					return textResult(
						`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`,
					);
				}
				if (!record.handle)
					return textResult(`Agent "${params.agent_id}" has no active conversation to steer.`);

				try {
					await steerAgent(record.handle, params.message);
					pi.events.emit("subagents:steered", { id: record.id, message: params.message });
					const tokens = formatLifetimeTokens(record);
					const contextPercent = record.contextPercent ?? null;
					const stateParts: string[] = [];
					if (tokens) stateParts.push(tokens);
					stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
					if (contextPercent !== null)
						stateParts.push(`context ${Math.round(contextPercent)}% full`);
					if (record.compactionCount)
						stateParts.push(
							`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`,
						);
					return textResult(
						`Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
							`Current state: ${stateParts.join(" · ")}`,
					);
				} catch (err) {
					return textResult(
						`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		}),
	);
}
