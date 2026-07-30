import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isHepiSubagentSession } from "../core/runtime/subagent-session.js";

interface MagicContextHandoffBridge {
	handoff(ctx: ExtensionCommandContext): Promise<
		| {
				context: string;
				setup?: (sessionManager: Pick<SessionManager, "getSessionId">) => Promise<void>;
		  }
		| undefined
	>;
}

declare global {
	var __hepiMagicContextHandoffByRuntime: WeakMap<object, MagicContextHandoffBridge> | undefined;
}

function runtimeIdentity(pi: ExtensionAPI): object {
	return typeof pi.events === "object" && pi.events !== null ? pi.events : pi;
}

function getMagicContextHandoff(pi: ExtensionAPI): MagicContextHandoffBridge | undefined {
	return globalThis.__hepiMagicContextHandoffByRuntime?.get(runtimeIdentity(pi));
}

async function startReplacementSession(
	ctx: ExtensionCommandContext,
	context: string,
	setup?: (sessionManager: Pick<SessionManager, "getSessionId">) => Promise<void>,
): Promise<void> {
	const parentSession = ctx.sessionManager.getSessionFile();
	const result = await ctx.newSession({
		...(parentSession === undefined ? {} : { parentSession }),
		setup: async (sessionManager) => {
			await setup?.(sessionManager);
			sessionManager.appendCustomMessageEntry("hepi-handoff", context, false);
		},
		withSession: async (replacement) => {
			replacement.ui.notify("Handoff context is ready.", "info");
		},
	});
	if (result.cancelled) ctx.ui.notify("Handoff cancelled.", "warning");
}

async function handoffWithPiCompaction(ctx: ExtensionCommandContext): Promise<void> {
	const summary = await new Promise<string>((resolve, reject) => {
		ctx.compact({
			onComplete: (result) => resolve(result.summary),
			onError: reject,
		});
	});
	await startReplacementSession(ctx, `<handoff-summary>\n${summary}\n</handoff-summary>`);
}

export function registerHandoffCommand(pi: ExtensionAPI): void {
	pi.registerCommand("handoff", {
		description: "Compact the current context and continue in a new session",
		handler: async (args, ctx) => {
			if (isHepiSubagentSession(pi)) return;
			if (args.trim() !== "") {
				ctx.ui.notify("Usage: /handoff", "error");
				return;
			}
			await ctx.waitForIdle();
			try {
				const magicContext = getMagicContextHandoff(pi);
				if (magicContext) {
					const handoff = await magicContext.handoff(ctx);
					if (handoff) {
						await startReplacementSession(ctx, handoff.context, handoff.setup);
						return;
					}
				}
				await handoffWithPiCompaction(ctx);
			} catch (error) {
				ctx.ui.notify(
					`Handoff failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
