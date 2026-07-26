import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	hasUnsupportedFindArguments,
	shouldSkipUnsupportedFindRewrite,
} from "./find-rewrite-compat.js";
import { type RtkRewriteProviderOptions, resolveRtkRewrite } from "./rtk-rewrite-provider.js";
import { splitLeadingEnvAssignments } from "./shell-env-prefix.js";
import type { RtkIntegrationConfig } from "./types.js";

export interface RewriteDecision {
	changed: boolean;
	originalCommand: string;
	rewrittenCommand: string;
	reason: "ok" | "empty" | "already_rtk" | "no_match" | "unsupported_shape";
	warning?: string | undefined;
}

export async function computeRewriteDecision(
	command: string,
	_config: RtkIntegrationConfig,
	pi: ExtensionAPI,
	rewriteOptions: RtkRewriteProviderOptions = {},
): Promise<RewriteDecision> {
	if (!command.trim()) {
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
	if (hasUnsupportedFindArguments(command)) {
		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			reason: "unsupported_shape",
		};
	}

	const result = await resolveRtkRewrite(pi, command, rewriteOptions);

	if (result.changed && result.rewrittenCommand) {
		if (shouldSkipUnsupportedFindRewrite(command, result.rewrittenCommand)) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "unsupported_shape",
			};
		}
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
