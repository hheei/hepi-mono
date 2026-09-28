import {
	type ExecResult,
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@hheei/pi-ext-core";
import type { OptimizerInfo } from "./info.js";
import type { RtkSettings } from "./settings.js";

interface RtkRuntime {
	rewrite(event: ToolCallEvent, context: ExtensionContext, settings: RtkSettings): Promise<void>;
	reset(): void;
}

// RTK overlays adapted from hheei/oh-my-pi omp-optimizer (MIT).
const REWRITE_CACHE_LIMIT = 256;
const SHELL_VALUE = `(?:"[^"]*"|'(?:'\\\\''|[^'])*'|[^\\s]+)`;
const LEADING_ENV_ASSIGNMENT = new RegExp(`^((?:[A-Za-z_][A-Za-z0-9_]*=${SHELL_VALUE}\\s+)*)`);
const FIND_UNSAFE_PREDICATE = /(?:^|\s)-(?:not|exec|ok|or|and|o|a)(?:\s|$)/;
const CHAIN_OPERATORS = new Set(["&&", "||", ";", "|"]);

/** Only parse the unambiguous shell subset needed by overlays, never a full shell grammar. */
export function splitRtkChain(command: string): string[] | null {
	const parts: string[] = [];
	let body = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const character = command[index] ?? "";
		if (quote !== undefined) {
			if (character === "\\" || (quote === '"' && (character === "$" || character === "`")))
				return null;
			body += character;
			if (character === quote) quote = undefined;
		} else if (character === "'" || character === '"') {
			quote = character;
			body += character;
		} else if ("\\$`\n()<>".includes(character)) return null;
		else if ((character === "&" || character === "|") && command[index + 1] === character) {
			parts.push(body, character + character);
			body = "";
			index++;
		} else if (character === ";" || character === "|") {
			parts.push(body, character);
			body = "";
		} else if (character === "&") return null;
		else body += character;
	}
	return quote === undefined ? [...parts, body] : null;
}

/** Produces one shell word; this is also the canonical already-wrapped command prefix. */
function shellExecutable(configuredPath: string): string {
	if (!configuredPath) return "rtk";
	return /^[A-Za-z0-9_./-]+$/u.test(configuredPath)
		? configuredPath
		: `'${configuredPath.replaceAll("'", `'\\''`)}'`;
}

function applyRtkOverlays(original: string, candidate: string, executable: string): string {
	if (splitRtkChain(original) === null) return executable === "rtk" ? candidate : original;
	const parts = splitRtkChain(candidate);
	if (parts === null) return executable === "rtk" ? candidate : original;
	return parts
		.map((part) => {
			if (CHAIN_OPERATORS.has(part)) return part;
			const leading = part.match(/^\s*/)?.[0] ?? "";
			let body = part.slice(leading.length);
			if (/^rtk\s+find\b/.test(body) && FIND_UNSAFE_PREDICATE.test(body))
				body = body.replace(/^rtk\s+/, "");
			const prefix = body.match(LEADING_ENV_ASSIGNMENT)?.[1] ?? "";
			const command = body.slice(prefix.length);
			// Do not guess whether a flag consumes the token "test" as its argument.
			if (/^bun\s+test(?:\s|$)/.test(command)) body = `${prefix}rtk test ${command}`;
			const finalPrefix = body.match(LEADING_ENV_ASSIGNMENT)?.[1] ?? "";
			const finalCommand = body.slice(finalPrefix.length);
			if (/^rtk(?:\s|$)/.test(finalCommand))
				body = finalPrefix + finalCommand.replace(/^rtk/u, executable);
			return leading + body;
		})
		.join("");
}

export function createRtkRuntime(pi: Pick<ExtensionAPI, "exec">, info: OptimizerInfo): RtkRuntime {
	let generation = 0;
	const activeQueries = new Set<AbortController>();
	// `rtk rewrite` costs a process spawn (~10ms on the tool-call critical path) but only depends on
	// the configured executable, the session cwd and the command, so a repeated command can reuse the
	// earlier answer. Oldest answers are evicted first, which keeps the newest ones for a long session.
	const rewrites = new Map<string, string | null>();
	const remember = (key: string, executionCommand: string | null): void => {
		if (rewrites.size >= REWRITE_CACHE_LIMIT) {
			const oldest = rewrites.keys().next().value;
			if (oldest !== undefined) rewrites.delete(oldest);
		}
		rewrites.set(key, executionCommand);
	};
	return {
		async rewrite(event, context, settings): Promise<void> {
			if (!settings.enabled || !isToolCallEventType("bash", event) || context.signal?.aborted)
				return;
			const input = event.input as Record<string, unknown>;
			const command = input.command;
			const target = input.target;
			if (
				typeof command !== "string" ||
				input.async === true ||
				input.pty === true ||
				(target !== undefined && target !== "local") ||
				!command.trim()
			)
				return;
			const executable = shellExecutable(settings.path);
			const trimmed = command.trimStart();
			const environment = trimmed.match(LEADING_ENV_ASSIGNMENT)?.[0] ?? "";
			const invocation = trimmed.slice(environment.length);
			const notify = (executionCommand: string, reason: string): void => {
				info(`RTK · ${command} → ${executionCommand}`, {
					toolCallId: event.toolCallId,
					originalCommand: command,
					executionCommand,
					reason,
				});
				input.command = executionCommand;
			};
			if (/^rtk(?:\s|$)/.test(invocation)) {
				if (!settings.path || executable === "rtk") return;
				let executionCommand = applyRtkOverlays(command, command, executable);
				if (executionCommand === command)
					executionCommand =
						command.slice(0, command.length - trimmed.length) +
						environment +
						invocation.replace(/^rtk/u, executable);
				notify(executionCommand, "configured RTK path");
				return;
			}
			if (invocation === executable || invocation.startsWith(`${executable} `)) return;
			const cacheKey = `${settings.path}\u0000${context.cwd}\u0000${command}`;
			const cached = rewrites.get(cacheKey);
			if (cached === null) return;
			if (cached !== undefined) {
				notify(cached, "rtk rewrite");
				return;
			}
			const captured = generation;
			const failure = (reason: string): void =>
				info(
					`RTK query failed · ${command} · ${reason}; original command retained`,
					{
						toolCallId: event.toolCallId,
						originalCommand: command,
						executionCommand: command,
						reason,
					},
					true,
				);
			const controller = new AbortController();
			activeQueries.add(controller);
			const signal = context.signal
				? AbortSignal.any([context.signal, controller.signal])
				: controller.signal;
			let result: ExecResult;
			try {
				result = await pi.exec(settings.path || "rtk", ["rewrite", command], {
					timeout: 1_000,
					signal,
				});
			} catch (error) {
				if (captured === generation && !context.signal?.aborted) failure(errorMessage(error));
				return;
			} finally {
				activeQueries.delete(controller);
			}
			if (captured !== generation || context.signal?.aborted) return;
			const output = result.stdout.trim();
			const reason = result.killed
				? "timeout"
				: ![0, 1, 3].includes(result.code)
					? result.stderr.trim() || (result.code === 2 ? "rewrite denied" : `exit ${result.code}`)
					: result.code !== 1 && !output
						? "rtk returned empty output"
						: undefined;
			if (reason !== undefined) return failure(reason);
			const executionCommand = applyRtkOverlays(
				command,
				result.code === 1 ? command : output,
				executable,
			);
			if (executionCommand === command) {
				remember(cacheKey, null);
				return;
			}
			remember(cacheKey, executionCommand);
			notify(executionCommand, "rtk rewrite");
		},
		reset(): void {
			for (const controller of activeQueries) controller.abort();
			activeQueries.clear();
			rewrites.clear();
			generation++;
		},
	};
}
