import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	getService,
	PARENT_CONTEXT_PROJECTION_SERVICE,
	type ParentContextHandoffResult,
} from "@hheei/pi-ext-core";

const registeredApis = new WeakSet<object>();

function nativeHandoffPayload(summary: string): string {
	return `<handoff-summary>\n${summary}\n</handoff-summary>`;
}

async function compactWithPi(ctx: ExtensionCommandContext): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		ctx.compact({
			onComplete: (result) => resolve(result.summary),
			onError: reject,
		});
	});
}

async function startReplacementSession(
	ctx: ExtensionCommandContext,
	payload: string | undefined,
	plan: ParentContextHandoffResult | undefined,
	signal: AbortSignal,
): Promise<void> {
	const parentSession = ctx.sessionManager.getSessionFile();
	const result = await ctx.newSession({
		...(parentSession === undefined ? {} : { parentSession }),
		setup: async (sessionManager: SessionManager): Promise<void> => {
			if (payload !== undefined)
				sessionManager.appendCustomMessageEntry("hepi-handoff", payload, false);
			if (plan !== undefined) await plan.install(sessionManager, signal);
		},
		withSession: async (replacement): Promise<void> => {
			replacement.ui.notify("Handoff context is ready.", "info");
		},
	});
	if (result.cancelled) ctx.ui.notify("Handoff cancelled.", "warning");
}

/** Registers the user-owned native compaction handoff command. */
export function registerHandoffCommand(pi: ExtensionAPI): void {
	if (registeredApis.has(pi)) return;
	pi.registerCommand("handoff", {
		description: "Compact the current context and continue in a new session",
		handler: async (args, ctx): Promise<void> => {
			const operation = new AbortController();
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /handoff", "error");
				operation.abort();
				return;
			}
			try {
				await ctx.waitForIdle();
				const prepared = await getService(pi, PARENT_CONTEXT_PROJECTION_SERVICE)?.prepare({
					purpose: "handoff",
					signal: operation.signal,
				});
				let plan: ParentContextHandoffResult | undefined;
				if (prepared?.kind === "result") {
					if (prepared.purpose !== "handoff" || typeof prepared.install !== "function")
						throw new Error("Invalid handoff projection");
					plan = prepared;
				}
				if (plan !== undefined) {
					await startReplacementSession(ctx, undefined, plan, operation.signal);
				} else if (prepared === undefined) {
					const summary = await compactWithPi(ctx);
					await startReplacementSession(
						ctx,
						nativeHandoffPayload(summary),
						undefined,
						operation.signal,
					);
				} else {
					throw new Error(
						"MCTX context projection is unavailable; native compaction is disabled while MCTX is active",
					);
				}
			} catch (error: unknown) {
				// Pi applies the replacement before setup, so no public rollback exists here.
				const reason = error instanceof Error ? `: ${error.message}` : "";
				ctx.ui.notify(`Handoff failed${reason}. The source session can be resumed.`, "error");
			} finally {
				operation.abort();
			}
		},
	});
	registeredApis.add(pi);
}
