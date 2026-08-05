import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { HepiRuntimeContext } from "../core/runtime/context.js";
import { DEFAULT_RETRY_SETTINGS, type RetrySettings } from "./settings.js";

const UNKNOWN_NO_DETAILS_RE = /Unknown error \(no error details in response\)/i;
const CODEX_WEBSOCKET_CONNECTION_LIMIT_RE =
	/websocket[_\s-]*connection[_\s-]*limit[_\s-]*reached|create a new websocket connection to continue/i;
const CODEX_GENERIC_PROCESSING_ERROR_RE =
	/Codex error:[\s\S]*An error occurred while processing your request/i;
const CODEX_GENERIC_RETRY_PROMPT_RE = /You can retry your request/i;
const RETRYABLE_HINT = "provider returned error";
const STATUS_KEY = "retry";
const STATUS_VISIBLE_MS = 8_000;
const INCOMING_STATUS_VISIBLE_MS = 1_500;
const DEFAULT_STALL_TIMEOUT_MS = 90_000;
const STALL_TIMEOUT_FLAG = "retry-stall-timeout-ms";
const STALL_TIMEOUT_ENV = "PI_RETRY_STALL_TIMEOUT_MS";
const STALL_WATCHDOG_TAG = "[stall-watchdog-retry]";

type StatusMode = "incoming" | "retry";

interface RetryPolicy {
	readonly enabled: boolean | undefined;
	readonly errors: readonly string[];
}

export interface RetryFeature {
	configure(settings: RetrySettings): void;
	start(runtime: HepiRuntimeContext): void;
	dispose(ctx: ExtensionContext): void;
}

export function parseRetryStallTimeoutMs(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "0" || normalized === "off" || normalized === "false") return 0;
	const timeoutMs = Number(normalized);
	return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.trunc(timeoutMs) : undefined;
}

function readRetryPolicy(ctx: ExtensionContext): RetryPolicy {
	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	});
	return {
		enabled: settings.getRetrySettings().enabled,
		errors: settings.drainErrors().map(({ scope, error }) => `${scope} settings: ${error.message}`),
	};
}

export function createRetryFeature(pi: ExtensionAPI, isCurrent: () => boolean): RetryFeature {
	pi.registerFlag(STALL_TIMEOUT_FLAG, {
		description: `Abort and auto-retry stalled provider streams after this many ms; use 0/off/false to disable. Defaults to ${DEFAULT_STALL_TIMEOUT_MS}.`,
		type: "string",
	});

	let settings = DEFAULT_RETRY_SETTINGS;
	let activeSessionId: string | undefined;
	let clearStatusTimer: NodeJS.Timeout | undefined;
	let stallTimer: NodeJS.Timeout | undefined;
	let statusMode: StatusMode | undefined;
	let providerWatchdogActive = false;
	let waitingForStallAbortMessage = false;
	let retryPolicyEnabled = true;
	let hasResolvedRetryPolicy = false;
	let warnedRetryPolicyDisabled = false;
	let warnedRetryPolicyReadFailure = false;

	const ownsContext = (ctx: ExtensionContext): boolean =>
		isCurrent() &&
		activeSessionId !== undefined &&
		ctx.sessionManager.getSessionId() === activeSessionId;
	const getStallTimeoutMs = (): number =>
		parseRetryStallTimeoutMs(pi.getFlag(STALL_TIMEOUT_FLAG)) ??
		parseRetryStallTimeoutMs(process.env[STALL_TIMEOUT_ENV]) ??
		settings.stallTimeoutMs;
	const disarmStallWatchdog = (): void => {
		if (stallTimer !== undefined) clearTimeout(stallTimer);
		stallTimer = undefined;
	};
	const clearStatus = (ctx: ExtensionContext): void => {
		if (clearStatusTimer !== undefined) clearTimeout(clearStatusTimer);
		clearStatusTimer = undefined;
		statusMode = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};
	const setTransientStatus = (
		ctx: ExtensionContext,
		mode: StatusMode,
		text: string,
		visibleMs: number,
	): void => {
		if (clearStatusTimer !== undefined) clearTimeout(clearStatusTimer);
		if (statusMode !== mode) ctx.ui.setStatus(STATUS_KEY, text);
		statusMode = mode;
		clearStatusTimer = setTimeout(() => {
			clearStatusTimer = undefined;
			if (statusMode !== mode || !ownsContext(ctx)) return;
			statusMode = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}, visibleMs);
	};
	const showRetryStatus = (ctx: ExtensionContext): void =>
		setTransientStatus(ctx, "retry", "retrying", STATUS_VISIBLE_MS);
	const showIncomingStatus = (ctx: ExtensionContext): void =>
		setTransientStatus(ctx, "incoming", "receiving", INCOMING_STATUS_VISIBLE_MS);
	const clearIncomingStatus = (ctx: ExtensionContext): void => {
		if (statusMode === "incoming") clearStatus(ctx);
	};
	const refreshRetryPolicy = (ctx: ExtensionContext): void => {
		const policy = readRetryPolicy(ctx);
		if (policy.errors.length > 0 && ctx.hasUI && !warnedRetryPolicyReadFailure) {
			warnedRetryPolicyReadFailure = true;
			const fallback = hasResolvedRetryPolicy
				? "preserving the last known policy"
				: "using Pi's fallback policy";
			ctx.ui.notify(
				`Retry could not read Pi retry settings; ${fallback}. ${policy.errors.join("; ")}`,
				"warning",
			);
		}
		if (policy.enabled === undefined || (policy.errors.length > 0 && hasResolvedRetryPolicy))
			return;
		retryPolicyEnabled = policy.enabled;
		hasResolvedRetryPolicy = true;
		if (retryPolicyEnabled) return;
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		clearStatus(ctx);
		if (ctx.hasUI && !warnedRetryPolicyDisabled) {
			warnedRetryPolicyDisabled = true;
			ctx.ui.notify(
				'Retry requires Pi setting "retry.enabled": true; retry hints and stall recovery are inactive while it is disabled.',
				"warning",
			);
		}
	};
	const armStallWatchdog = (ctx: ExtensionContext): void => {
		disarmStallWatchdog();
		if (!retryPolicyEnabled || getStallTimeoutMs() === 0) {
			providerWatchdogActive = false;
			return;
		}
		providerWatchdogActive = true;
		stallTimer = setTimeout(() => {
			stallTimer = undefined;
			providerWatchdogActive = false;
			if (!ownsContext(ctx) || ctx.isIdle()) return;
			waitingForStallAbortMessage = true;
			if (ctx.hasUI) showRetryStatus(ctx);
			ctx.abort();
		}, getStallTimeoutMs());
	};
	const observeProviderOrStreamEvent = (ctx: ExtensionContext): void => {
		if (!providerWatchdogActive || waitingForStallAbortMessage) return;
		if (ctx.isIdle()) {
			disarmStallWatchdog();
			providerWatchdogActive = false;
			clearIncomingStatus(ctx);
			return;
		}
		if (ctx.hasUI) showIncomingStatus(ctx);
		armStallWatchdog(ctx);
	};

	pi.on("before_provider_request", (_event, ctx) => {
		if (!settings.enabled || !ownsContext(ctx)) return;
		refreshRetryPolicy(ctx);
		if (ctx.hasUI) clearIncomingStatus(ctx);
		armStallWatchdog(ctx);
	});
	pi.on("after_provider_response", (_event, ctx) => {
		if (settings.enabled && ownsContext(ctx)) observeProviderOrStreamEvent(ctx);
	});
	pi.on("message_start", (_event, ctx) => {
		if (settings.enabled && ownsContext(ctx)) observeProviderOrStreamEvent(ctx);
	});
	pi.on("message_update", (_event, ctx) => {
		if (settings.enabled && ownsContext(ctx)) observeProviderOrStreamEvent(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!settings.enabled || !ownsContext(ctx)) return;
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		if (ctx.hasUI) clearIncomingStatus(ctx);
	});
	pi.on("message_end", (event, ctx) => {
		if (!settings.enabled || !ownsContext(ctx) || event.message.role !== "assistant") return;
		disarmStallWatchdog();
		providerWatchdogActive = false;
		if (ctx.hasUI) clearIncomingStatus(ctx);
		const errorMessage = event.message.errorMessage;
		if (waitingForStallAbortMessage) {
			waitingForStallAbortMessage = false;
			const original = typeof errorMessage === "string" ? errorMessage : "Provider stream stalled.";
			if (!original.includes(STALL_WATCHDOG_TAG))
				return {
					message: {
						...event.message,
						stopReason: "error",
						errorMessage: `${original}\n\n${STALL_WATCHDOG_TAG} ${RETRYABLE_HINT}; treating stalled provider stream as retryable.`,
					},
				};
		}
		if (event.message.stopReason !== "error" || typeof errorMessage !== "string") return;
		const matched = UNKNOWN_NO_DETAILS_RE.test(errorMessage)
			? { tag: "[unknown-error-retry]", label: "empty-detail provider failure" }
			: CODEX_WEBSOCKET_CONNECTION_LIMIT_RE.test(errorMessage)
				? { tag: "[codex-websocket-limit-retry]", label: "Codex websocket connection limit" }
				: CODEX_GENERIC_PROCESSING_ERROR_RE.test(errorMessage) &&
						CODEX_GENERIC_RETRY_PROMPT_RE.test(errorMessage)
					? { tag: "[codex-generic-retry]", label: "Codex retryable backend failure" }
					: undefined;
		if (matched === undefined || errorMessage.includes(matched.tag)) return;
		if (ctx.hasUI && retryPolicyEnabled) {
			showRetryStatus(ctx);
			ctx.ui.notify(`Matched ${matched.label}; letting Pi auto-retry this turn.`, "warning");
		}
		return {
			message: {
				...event.message,
				errorMessage: `${errorMessage}\n\n${matched.tag} ${RETRYABLE_HINT}; treating ${matched.label} as retryable.`,
			},
		};
	});

	return {
		configure(next) {
			settings = next;
		},
		start(runtime) {
			activeSessionId = runtime.ctx.sessionManager.getSessionId();
			if (!settings.enabled) return;
			refreshRetryPolicy(runtime.ctx);
		},
		dispose(ctx) {
			if (activeSessionId !== ctx.sessionManager.getSessionId()) return;
			disarmStallWatchdog();
			providerWatchdogActive = false;
			waitingForStallAbortMessage = false;
			clearStatus(ctx);
			activeSessionId = undefined;
		},
	};
}
