import { homedir } from "node:os";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ProcessResult } from "./session-manager.js";
import { SessionManager } from "./session-manager.js";
import { executeSshExec, validateSshExecArgs } from "./ssh-exec.js";
import { findConfiguredHosts, type SshHostRecord, validateSshHostPattern } from "./ssh-host.js";
import { executeSshMount, validateSshMountArgs } from "./ssh-mount.js";
import { readProcessOutputTail } from "./stream-output.js";

type SshToolDetails = Record<string, unknown>;
type SshToolResult = AgentToolResult<SshToolDetails>;

interface SshExtensionSettings {
	commandTimeoutSeconds: number;
	controlPersistSeconds: number;
	serverAliveIntervalSeconds: number;
	serverAliveCountMax: number;
}

const DEFAULT_SETTINGS: SshExtensionSettings = {
	commandTimeoutSeconds: 10,
	controlPersistSeconds: 3600,
	serverAliveIntervalSeconds: 300,
	serverAliveCountMax: 3,
};

export default function register(pi: ExtensionAPI) {
	const manager = createManager(DEFAULT_SETTINGS);

	pi.registerTool({
		name: "ssh_host",
		label: "SSH Host",
		description: "Find configured SSH aliases from the local OpenSSH config.",
		promptSnippet: "Find configured SSH aliases before connecting to a remote host.",
		promptGuidelines: [
			"Use this tool first when you are not sure whether a remote host alias exists.",
		],
		parameters: Type.Object({
			ssh_host: Type.String(),
		}),
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ssh_host "));
			text += theme.fg("accent", `"${args.ssh_host}"`);
			return new Text(text, 0, 0);
		},
		renderResult: renderCollapsedResult,
		async execute(_id, params) {
			try {
				const pattern = validateSshHostPattern(params);
				const hosts = await findConfiguredHosts(pattern);
				return hostLookupResult(pattern, hosts);
			} catch (error) {
				return errorResult(error, { hosts: [] });
			}
		},
	});

	pi.registerTool({
		name: "ssh_mount",
		label: "SSH Mount",
		description: "Mount a remote host locally through sshfs.",
		promptSnippet: "Mount a remote SSH host so local file tools can operate on it.",
		promptGuidelines: ["Use host first if the SSH alias is uncertain."],
		parameters: Type.Object({
			host: Type.String(),
		}),
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ssh_mount "));
			text += theme.fg("accent", `@${args.host}`);
			return new Text(text, 0, 0);
		},
		renderResult: renderCollapsedResult,
		async execute(_id, params) {
			const args = validateSshMountArgs(params);
			try {
				const runner = async (runnerArgs: string[], timeoutMs?: number) =>
					await runCleanupSshProcess(
						manager.sshBin,
						runnerArgs,
						timeoutMs,
						manager.sensitiveValues(args.host),
					);
				return mountResult(await executeSshMount(manager, args, runner));
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "ssh_exec",
		label: "SSH Exec",
		description: "Run a non-interactive command on a remote OpenSSH host.",
		promptSnippet: "Run a remote SSH command for inspection, verification, or service control.",
		promptGuidelines: ["Use host first if the SSH alias is uncertain."],
		parameters: Type.Object({
			host: Type.String(),
			command: Type.String(),
			timeout: Type.Optional(Type.Number()),
		}),
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ssh_exec "));
			text += theme.fg("accent", `@${args.host}`);
			text += theme.fg(
				"dim",
				` (timeout: ${args.timeout ?? DEFAULT_SETTINGS.commandTimeoutSeconds}s)`,
			);

			text += `\n${theme.fg("bashMode", `$ ${args.command}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult: renderCollapsedResult,
		async execute(_id, params) {
			const args = validateSshExecArgs({
				...(params as Record<string, unknown>),
				timeout: (params as { timeout?: number }).timeout ?? DEFAULT_SETTINGS.commandTimeoutSeconds,
			});
			try {
				const result = await executeSshExec(manager, args, { timeoutMode: "result" });
				return sshExecResult(result, result.exitCode !== 0 || result.exitCode === null);
			} catch (error) {
				return errorResult(error, {
					host: args.host,
					exitCode: null,
					durationMs: 0,
					truncated: false,
					notice: errorMessage(error),
				});
			}
		},
	});
}

function createManager(settings: SshExtensionSettings): SessionManager {
	return new SessionManager({
		controlPersist: String(settings.controlPersistSeconds),
		serverAliveIntervalSeconds: settings.serverAliveIntervalSeconds,
		serverAliveCountMax: settings.serverAliveCountMax,
	});
}

function hostLookupResult(pattern: string, hosts: SshHostRecord[]): SshToolResult {
	return {
		content: [
			{
				type: "text",
				text:
					hosts.length > 0
						? hosts.map((host) => host.display).join("\n")
						: `No \`${pattern}\` host.`,
			},
		],
		details: { hosts },
	};
}

function mountResult(result: { host: string; localPath: string; status: string }): SshToolResult {
	const displayPath = ensureTrailingSlash(formatDisplayPath(result.localPath));
	const text = ["Success.", `Local path: ${displayPath}`, `Home path: ${displayPath}...`].join(
		"\n",
	);
	return {
		content: [{ type: "text", text }],
		details: {
			host: result.host,
			localPath: result.localPath,
			status: result.status,
		},
	};
}

function sshExecResult(
	result: {
		host: string;
		exitCode: number | null;
		output?: string;
		stdout: string;
		stderr: string;
		durationMs: number;
		truncated: boolean;
		totalBytes?: number;
		outputBytes?: number;
		totalLines?: number;
		outputLines?: number;
		notice?: string;
	},
	isError: boolean,
): SshToolResult {
	const notice =
		result.notice ??
		(isError && result.exitCode !== null && result.exitCode !== 0
			? `Command exited with code ${result.exitCode}`
			: undefined);
	const outputText = result.output ?? `${result.stdout}${result.stderr}`;
	const displayOutput = outputText ? outputText.trimEnd() : "(no output)";
	const text = notice ? `${displayOutput}\n\n${notice}` : outputText || "(no output)";

	return {
		content: [{ type: "text", text }],
		details: {
			host: result.host,
			exitCode: result.exitCode,
			output: result.output,
			durationMs: result.durationMs,
			truncated: result.truncated,
			totalBytes: result.totalBytes,
			outputBytes: result.outputBytes,
			totalLines: result.totalLines,
			outputLines: result.outputLines,
			...(notice ? { notice } : {}),
		},
	};
}

function errorResult(error: unknown, details: Record<string, unknown> = {}): SshToolResult {
	return {
		content: [{ type: "text", text: errorMessage(error) }],
		details,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatDisplayPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

function ensureTrailingSlash(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

async function runCleanupSshProcess(
	sshBin: string,
	args: string[],
	timeoutMs = 10_000,
	sensitiveValues: string[] = [],
): Promise<ProcessResult> {
	const { spawn } = await import("node:child_process");
	const child = spawn(sshBin, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let timedOut = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
	}, timeoutMs);

	try {
		const [output, exitCode] = await Promise.all([
			readProcessOutputTail(child.stdout, child.stderr, sensitiveValues),
			new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => resolve(code));
			}),
		]);
		return {
			exitCode: timedOut ? null : exitCode,
			output: output.text,
			stdout: output.stdout,
			stderr: output.stderr,
			truncated: output.truncated,
			totalBytes: output.totalBytes,
			outputBytes: output.outputBytes,
			totalLines: output.totalLines,
			outputLines: output.outputLines,
			...(timedOut
				? { notice: `SSH cleanup timed out after ${Math.round(timeoutMs / 1000)}s` }
				: {}),
		};
	} finally {
		clearTimeout(timeout);
		if (killTimer) clearTimeout(killTimer);
	}
}

function renderCollapsedResult(
	result: SshToolResult,
	{ expanded }: ToolRenderResultOptions,
	theme: Theme,
) {
	const text = result.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trimEnd();
	if (!text) return new Text("", 0, 0);

	const durationMs = result.details?.durationMs;
	const durationText =
		typeof durationMs === "number"
			? theme.fg("muted", `Took ${(durationMs / 1000).toFixed(1)}s`)
			: "";
	if (expanded) {
		const output = theme.fg("toolOutput", text);
		return new Text(durationText ? `\n${output}\n\n${durationText}` : `\n${output}`, 0, 0);
	}

	const lines = text.split("\n");
	const previewLines = 5;
	const skipped = Math.max(0, lines.length - previewLines);
	const preview = lines.slice(-previewLines).join("\n");
	let output = theme.fg("toolOutput", preview);
	if (skipped > 0) {
		output = `${theme.fg("dim", `... (${skipped} earlier lines, ctrl+o to expand)`)}\n${output}`;
	}

	if (durationText) output += `\n\n${durationText}`;
	return new Text(`\n${output}`, 0, 0);
}
