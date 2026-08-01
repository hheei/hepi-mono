import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

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
	payload: string,
): Promise<void> {
	const parentSession = ctx.sessionManager.getSessionFile();
	const result = await ctx.newSession({
		...(parentSession === undefined ? {} : { parentSession }),
		setup: async (sessionManager: SessionManager): Promise<void> => {
			sessionManager.appendCustomMessageEntry("hepi-handoff", payload, false);
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
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /handoff", "error");
				return;
			}
			try {
				await ctx.waitForIdle();
				const summary = await compactWithPi(ctx);
				await startReplacementSession(ctx, nativeHandoffPayload(summary));
			} catch {
				// Pi applies the replacement before setup, so no public rollback exists here.
				ctx.ui.notify("Handoff failed. The source session can be resumed.", "error");
			}
		},
	});
	registeredApis.add(pi);
}
