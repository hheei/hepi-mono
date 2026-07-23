import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type RtkRewriteProviderOptions, resolveRtkRewrite } from "./rtk-rewrite-provider.js";
import { splitLeadingEnvAssignments } from "./shell-env-prefix.js";
import type { RtkIntegrationConfig } from "./types.js";

export interface RewriteDecision {
	changed: boolean;
	originalCommand: string;
	rewrittenCommand: string;
	reason: "ok" | "empty" | "already_rtk" | "no_match";
	warning?: string | undefined;
}

const FIND_COMMAND_PATTERN = /^(?:(?:command|env)\s+)?(?:\/[^\s]+\/)?find(?:\s|$)/u;
const UNSUPPORTED_RTK_FIND_TOKEN_PATTERN =
	/(?:^|\s)(?:\\[()]|["'][()]["']|[(),]|!|-a(?:nd)?|-o(?:r)?|-not|-(?:delete|exec(?:dir)?|fls|f?print(?:0|f)?|fprintf|ls|ok(?:dir)?|prune|quit))(?=\s|[;&|]|$)/u;

function shouldBypassRtkFindRewrite(command: string): boolean {
	const effectiveCommand = splitLeadingEnvAssignments(command.trimStart()).command.trimStart();
	return (
		FIND_COMMAND_PATTERN.test(effectiveCommand) &&
		UNSUPPORTED_RTK_FIND_TOKEN_PATTERN.test(effectiveCommand)
	);
}

export async function computeRewriteDecision(
	command: string,
	_config: RtkIntegrationConfig,
	pi: ExtensionAPI,
	rewriteOptions: RtkRewriteProviderOptions = {},
): Promise<RewriteDecision> {
	if (!command?.trim()) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "empty" };
	}

	const trimmedStart = command.trimStart();
	const effectiveCommand = splitLeadingEnvAssignments(trimmedStart).command.trimStart();
	if (effectiveCommand === "rtk" || effectiveCommand.startsWith("rtk ")) {
		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			reason: "already_rtk",
		};
	}

	if (shouldBypassRtkFindRewrite(command)) {
		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			reason: "no_match",
		};
	}

	const result = await resolveRtkRewrite(pi, command, rewriteOptions);

	if (result.changed && result.rewrittenCommand) {
		return {
			changed: true,
			originalCommand: command,
			rewrittenCommand: result.rewrittenCommand,
			reason: "ok",
		};
	}

	return {
		changed: false,
		originalCommand: command,
		rewrittenCommand: command,
		reason: "no_match",
		warning: result.error,
	};
}
