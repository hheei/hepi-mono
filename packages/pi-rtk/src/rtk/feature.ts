import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { computeRewriteDecision } from "./command-rewriter.js";
import { loadRtkConfig } from "./config.js";
import { normalizeRtkIntegrationConfig } from "./config-store.js";
import { compactToolResult, type ToolResultCompactionMetadata } from "./output-compactor.js";
import { createOutputMetrics } from "./output-metrics.js";
import { toRecord } from "./record-utils.js";
import { applyRewrittenCommandShellSafetyFixups } from "./rewrite-pipeline-safety.js";
import { applyRtkCommandEnvironment } from "./rtk-command-environment.js";
import { type RtkExecutableResolution, resolveRtkExecutable } from "./rtk-executable-resolver.js";
import { shouldSkipCommandHandlingWhenRtkMissing } from "./runtime-guard.js";
import { sanitizeStreamingBashExecutionResult } from "./tool-execution-sanitizer.js";
import type { RtkIntegrationConfig, RuntimeStatus } from "./types.js";

export interface RtkFeature {
	start(runtime: { pi: ExtensionAPI; ctx: ExtensionContext }): Promise<void>;
	dispose(sessionId: string): void;
	getConfig(): RtkIntegrationConfig;
	setConfig(config: RtkIntegrationConfig): void;
	getStatus(): RuntimeStatus;
	refresh(force?: boolean): Promise<RuntimeStatus>;
	metrics(): string;
	clearMetrics(): void;
}
function mergeDetails(
	existing: unknown,
	metadata: ToolResultCompactionMetadata,
): Record<string, unknown> {
	const details = toRecord(existing);
	const nested = toRecord(details.metadata);
	return { ...details, rtkCompaction: metadata, metadata: { ...nested, rtkCompaction: metadata } };
}
export function createRtkFeature(agentDir: string = getAgentDir()): RtkFeature {
	let sessionId: string | undefined;
	let config = normalizeRtkIntegrationConfig(undefined);
	let status: RuntimeStatus = { rtkAvailable: false };
	const active = new Map<string, string>();
	const outputMetrics = createOutputMetrics();
	let piRef: ExtensionAPI | undefined;
	let handlersRegistered = false;
	let lastRefreshAt = 0;
	let refreshRevision = 0;
	let sessionOwner: AbortController | undefined;
	const isCurrentSession = (
		ctx: { sessionManager?: { getSessionId(): string } } | undefined,
	): boolean => !ctx?.sessionManager || ctx.sessionManager.getSessionId() === sessionId;
	const refresh = async (force = false): Promise<RuntimeStatus> => {
		if (!force && lastRefreshAt > 0 && Date.now() - lastRefreshAt < 30_000) return status;
		const pi = piRef;
		if (!pi) return status;
		const revision = ++refreshRevision;
		const owner = sessionOwner;
		let resolution: RtkExecutableResolution | undefined;
		try {
			resolution = await resolveRtkExecutable(pi, owner ? { signal: owner.signal } : {});
			const result = await pi.exec(
				resolution.command,
				["--version"],
				owner ? { timeout: 5000, signal: owner.signal } : { timeout: 5000 },
			);
			if (revision !== refreshRevision || piRef !== pi) return status;
			lastRefreshAt = Date.now();
			status = {
				rtkAvailable: result.code === 0,
				lastCheckedAt: Date.now(),
				lastError:
					result.code === 0
						? undefined
						: (result.stderr || result.stdout || `exit ${result.code}`).trim(),
				rtkExecutablePath: resolution.resolvedPath,
				rtkExecutableCommand: resolution.command,
				rtkExecutableResolver: resolution.resolver,
				rtkExecutableResolutionWarning: resolution.warning,
			};
		} catch (error) {
			if (owner?.signal.aborted || revision !== refreshRevision || piRef !== pi) return status;
			status = {
				rtkAvailable: false,
				lastCheckedAt: Date.now(),
				lastError: error instanceof Error ? error.message : String(error),
				rtkExecutablePath: resolution?.resolvedPath,
				rtkExecutableCommand: resolution?.command,
				rtkExecutableResolver: resolution?.resolver,
			};
		}
		return status;
	};
	return {
		async start(runtime) {
			sessionOwner?.abort();
			sessionOwner = new AbortController();
			piRef = runtime.pi;
			sessionId = runtime.ctx.sessionManager.getSessionId();
			const loaded = await loadRtkConfig(agentDir);
			config = loaded.config;
			if (loaded.warning && runtime.ctx.hasUI) runtime.ctx.ui.notify(loaded.warning, "warning");
			await refresh(true);
			if (handlersRegistered) return;
			handlersRegistered = true;
			runtime.pi.on("tool_call", async (event, ctx) => {
				if (!isCurrentSession(ctx) || !config.enabled || !isToolCallEventType("bash", event))
					return {};
				if (config.mode === "rewrite") {
					const compatibility = (
						await import("./windows-command-helpers.js")
					).applyWindowsBashCompatibilityFixes(event.input.command);
					event.input.command = compatibility.command;
				}
				await refresh();
				if (shouldSkipCommandHandlingWhenRtkMissing(config, status)) {
					const message = `RTK is unavailable${status.lastError ? `: ${status.lastError}` : ""}`;
					if (ctx.hasUI) ctx.ui.notify(message, "error");
					return { block: true, reason: message };
				}
				const resolution = status.rtkExecutableCommand
					? {
							command: status.rtkExecutableCommand,
							resolvedPath: status.rtkExecutablePath,
							resolver: (status.rtkExecutableResolver === "where" ? "where" : "which") as
								| "where"
								| "which",
						}
					: undefined;
				const decision = await computeRewriteDecision(
					event.input.command,
					config,
					runtime.pi,
					resolution ? { executableResolution: resolution } : {},
				);
				if (!decision.changed) {
					if (decision.warning && ctx.hasUI)
						ctx.ui.notify(`RTK rewrite skipped: ${decision.warning}`, "warning");
					return {};
				}
				if (config.mode === "rewrite") {
					event.input.command = applyRewrittenCommandShellSafetyFixups(
						applyRtkCommandEnvironment(decision.rewrittenCommand),
					);
				} else if (ctx.hasUI) ctx.ui.notify(`RTK suggestion: ${decision.rewrittenCommand}`, "info");
				return {};
			});
			const onUnsupportedToolResult = runtime.pi.on as unknown as (
				event: "tool_result",
				handler: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<unknown>,
			) => unknown;
			onUnsupportedToolResult("tool_result", async (event, ctx) => {
				if (!isCurrentSession(ctx) || !config.enabled || !config.outputCompaction.enabled)
					return {};
				try {
					const outcome = compactToolResult(
						{ toolName: event.toolName, input: event.input, content: event.content },
						config,
						outputMetrics,
					);
					if (!outcome.changed) return {};
					return {
						content: outcome.content,
						details: outcome.metadata ? mergeDetails(event.details, outcome.metadata) : undefined,
					};
				} catch (error) {
					if (ctx.hasUI)
						ctx.ui.notify(
							`RTK output compaction failed: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					return {};
				}
			});
			runtime.pi.on(
				"tool_execution_start",
				async (event: { toolName: string; toolCallId?: string; args?: unknown }) => {
					if (sessionId === undefined) return;
					if (
						config.outputCompaction.enabled &&
						event.toolName === "bash" &&
						typeof event.toolCallId === "string"
					)
						active.set(event.toolCallId, String(toRecord(event.args).command ?? ""));
				},
			);
			runtime.pi.on(
				"tool_execution_update",
				async (event: {
					toolName: string;
					toolCallId: string;
					partialResult: Parameters<typeof sanitizeStreamingBashExecutionResult>[0];
				}) => {
					if (sessionId === undefined || event.toolName !== "bash") return;
					const result = sanitizeStreamingBashExecutionResult(
						event.partialResult,
						active.get(event.toolCallId),
					);
					if (result.changed) event.partialResult = result.result;
				},
			);
			runtime.pi.on(
				"tool_execution_end",
				async (event: {
					toolName: string;
					toolCallId: string;
					result: Parameters<typeof sanitizeStreamingBashExecutionResult>[0];
				}) => {
					if (sessionId === undefined || event.toolName !== "bash") return;
					const result = sanitizeStreamingBashExecutionResult(
						event.result,
						active.get(event.toolCallId),
					);
					if (result.changed) event.result = result.result;
					active.delete(event.toolCallId);
				},
			);
		},
		dispose(id) {
			if (sessionId === id) {
				refreshRevision++;
				sessionOwner?.abort();
				sessionOwner = undefined;
				sessionId = undefined;
				active.clear();
				outputMetrics.clear();
				piRef = undefined;
				lastRefreshAt = 0;
			}
		},
		getConfig: () => config,
		setConfig(next) {
			config = normalizeRtkIntegrationConfig(next);
		},
		getStatus: () => status,
		refresh,
		metrics: () => outputMetrics.summary(),
		clearMetrics: () => outputMetrics.clear(),
	};
}
