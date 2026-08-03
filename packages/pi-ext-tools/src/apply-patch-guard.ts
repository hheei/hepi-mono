import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const APPLY_PATCH_COMMAND = /(?:^|[\n;&|()])\s*(?:command\s+)?apply_patch\s/;

declare global {
	var __piExtToolsApplyPatchGuardRegistrations: WeakMap<object, symbol> | undefined;
}

function currentRegistration(pi: ExtensionAPI): () => boolean {
	const identity: object = typeof pi.events === "object" && pi.events !== null ? pi.events : pi;
	let registrations = globalThis.__piExtToolsApplyPatchGuardRegistrations;
	if (registrations === undefined) {
		registrations = new WeakMap();
		globalThis.__piExtToolsApplyPatchGuardRegistrations = registrations;
	}
	const token = Symbol("pi-ext-tools-apply-patch-guard");
	registrations.set(identity, token);
	return () => registrations.get(identity) === token;
}

/** Detects a streamed shell attempt to invoke apply_patch, excluding plain mentions. */
export function hasStreamingApplyPatchCommand(command: string): boolean {
	return APPLY_PATCH_COMMAND.test(command);
}

function blockReason(activeTools: readonly string[]): string {
	const alternatives = ["edit", "write"].filter((name) => activeTools.includes(name));
	if (alternatives.length === 0)
		return "`apply_patch` is unavailable; the call was aborted. No supported file-editing tool is active. Enable `apply_patch`, `edit`, or `write` before retrying.";
	const names = alternatives.map((name) => `\`${name}\``);
	const action = names.length === 1 ? names[0] : `${names[0]} or ${names[1]}`;
	return `\`apply_patch\` is unavailable; the call was aborted. Continue with ${action}. Do not retry \`apply_patch\`.`;
}

/**
 * Stops shell-based apply_patch attempts only while Loadout has made the canonical
 * tool inactive. Pi retains event handlers across /reload, so stale registrations
 * become inert through the runtime-scoped token above.
 */
export function registerApplyPatchGuard(pi: ExtensionAPI): void {
	const isCurrent = currentRegistration(pi);
	let interrupted = false;
	let pendingReason: string | undefined;
	pi.on("before_agent_start", () => {
		if (!isCurrent()) return;
		interrupted = false;
	});
	pi.on("session_start", () => {
		if (!isCurrent()) return;
		interrupted = false;
		pendingReason = undefined;
	});
	pi.on("agent_settled", () => {
		if (!isCurrent() || pendingReason === undefined) return;
		const reason = pendingReason;
		pendingReason = undefined;
		pi.sendMessage(
			{
				customType: "apply-patch-guard",
				content: reason,
				display: true,
			},
			{ triggerTurn: true },
		);
	});
	pi.on("session_shutdown", () => {
		if (!isCurrent()) return;
		pendingReason = undefined;
	});
	pi.on("message_update", (event, context) => {
		if (interrupted || !isCurrent() || event.assistantMessageEvent.type !== "toolcall_delta")
			return;
		if (pi.getActiveTools().includes("apply_patch")) return;
		const update = event.assistantMessageEvent;
		const content = update.partial.content[update.contentIndex];
		if (content?.type !== "toolCall" || content.name !== "bash") return;
		const command = content.arguments.command;
		if (typeof command !== "string" || !hasStreamingApplyPatchCommand(command)) return;
		interrupted = true;
		pendingReason = blockReason(pi.getActiveTools());
		context.abort();
	});
}
