import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const APPLY_PATCH_COMMAND = /(?:^|[\n;&|()])\s*(?:command\s+)?apply_patch\s/;
const NO_EDIT_TOOL_GUIDANCE =
	"`apply_patch` is unavailable; the call was aborted. No supported file-editing tool is active. Enable `apply_patch`, `edit`, or `write` before retrying.";
const APPLY_PATCH_RETRY_WARNING = "Do not retry `apply_patch`.";

/** Detects a streamed shell attempt to invoke apply_patch, excluding plain mentions. */
export function hasStreamingApplyPatchCommand(command: string): boolean {
	return APPLY_PATCH_COMMAND.test(command);
}

function blockReason(activeTools: readonly string[]): string {
	const alternatives = ["edit", "write"].filter((name) => activeTools.includes(name));
	if (alternatives.length === 0) return NO_EDIT_TOOL_GUIDANCE;
	const names = alternatives.map((name) => `\`${name}\``);
	const action = names.length === 1 ? names[0] : `${names[0]} or ${names[1]}`;
	return `\`apply_patch\` is unavailable; the call was aborted. Continue with ${action}. ${APPLY_PATCH_RETRY_WARNING}`;
}

/** Stops shell-based apply_patch attempts while Loadout has made the canonical tool inactive. */
export function registerApplyPatchGuard(pi: ExtensionAPI): void {
	let interrupted = false;
	let pendingReason: string | undefined;
	pi.on("before_agent_start", () => {
		interrupted = false;
	});
	pi.on("session_start", () => {
		interrupted = false;
		pendingReason = undefined;
	});
	pi.on("agent_settled", () => {
		if (pendingReason === undefined) return;
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
		pendingReason = undefined;
	});
	pi.on("message_update", (event, context) => {
		if (interrupted || event.assistantMessageEvent.type !== "toolcall_delta") return;
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
