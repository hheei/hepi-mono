#!/usr/bin/env bun
import { homedir } from "node:os";
import type { ProcessResult, SshMountResult } from "./session-manager.js";
import { SessionManager } from "./session-manager.js";
import {
	type ExecuteSshExecOptions,
	executeSshExec,
	type SshExecArgs,
	type SshExecResult,
	validateSshExecArgs,
} from "./ssh-exec.js";
import { findConfiguredHosts, type SshHostRecord, validateSshHostPattern } from "./ssh-hosts.js";
import { executeSshMount, type SshMountArgs, validateSshMountArgs } from "./ssh-mount.js";
import { readProcessOutputTail } from "./stream-output.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method?: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

interface McpServerOptions {
	execute?: (args: SshExecArgs) => Promise<SshExecResult>;
	mount?: (args: SshMountArgs) => Promise<SshMountResult>;
	findHosts?: (pattern: string) => Promise<SshHostRecord[]>;
	disabledHosts?: Iterable<string>;
	manager?: SessionManager;
}

interface SshExecStructuredContent {
	host: string;
	exitCode: number | null;
	output?: string;
	durationMs: number;
	truncated: boolean;
	totalBytes?: number;
	outputBytes?: number;
	totalLines?: number;
	outputLines?: number;
	notice?: string;
}

interface SshMountStructuredContent {
	host: string;
	localPath: string;
	status: SshMountResult["status"];
}

interface SshHostStructuredContent {
	hosts: SshHostRecord[];
}

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "ssh", version: "0.5.0" };

const SSH_EXEC_TOOL = {
	name: "ssh_exec",
	description:
		"Run a non-interactive command on a remote OpenSSH host. If you are unsure whether the alias exists, use host first. Returns bounded output and exit metadata. Timeout defaults to 10 seconds.",
	inputSchema: {
		type: "object",
		properties: {
			host: { type: "string" },
			command: { type: "string" },
			timeout: { type: "number", default: 10 },
		},
		required: ["host", "command"],
	},
};

const SSH_MOUNT_TOOL = {
	name: "ssh_mount",
	description:
		"Mount a remote OpenSSH host locally through sshfs so built-in read, edit, and write tools can work on the returned local path. If the alias is uncertain, use host first.",
	inputSchema: {
		type: "object",
		properties: {
			host: { type: "string" },
		},
		required: ["host"],
	},
};

const SSH_HOST_TOOL = {
	name: "ssh_host",
	description:
		"Find SSH hosts from the local OpenSSH config. Use `*` to list all hosts, or pass a regex-like pattern such as `ileqm|sccpu` to filter aliases.",
	inputSchema: {
		type: "object",
		properties: {
			ssh_host: { type: "string" },
		},
		required: ["ssh_host"],
	},
};

export function createMcpServer(options: McpServerOptions = {}) {
	const manager = options.manager ?? new SessionManager();
	const execute =
		options.execute ??
		(async (args: SshExecArgs) =>
			await executeSshExec(manager, args, {
				timeoutMode: "result",
			} satisfies ExecuteSshExecOptions));
	const mount =
		options.mount ??
		(async (args: SshMountArgs) => {
			const runner = async (runnerArgs: string[], timeoutMs?: number) =>
				await runCleanupSshProcess(
					manager.sshBin,
					runnerArgs,
					timeoutMs,
					manager.sensitiveValues(args.host),
				);
			return await executeSshMount(manager, args, runner);
		});
	const disabledHosts = new Set(options.disabledHosts ?? disabledHostsFromEnv());
	const findHosts =
		options.findHosts ?? (async (pattern: string) => await findConfiguredHosts(pattern));
	const filteredFindHosts = async (pattern: string) =>
		filterDisabledHosts(await findHosts(pattern), disabledHosts);
	return {
		manager,
		async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
			const id = message.id ?? null;
			try {
				switch (message.method) {
					case "initialize":
						return resultResponse(id, {
							protocolVersion: requestedProtocolVersion(message.params),
							serverInfo: SERVER_INFO,
							capabilities: { tools: {} },
						});
					case "notifications/initialized":
						return undefined;
					case "ping":
						return resultResponse(id, {});
					case "tools/list":
						return resultResponse(id, { tools: [SSH_EXEC_TOOL, SSH_MOUNT_TOOL, SSH_HOST_TOOL] });
					case "tools/call":
						return await handleToolCall(
							id,
							message.params,
							execute,
							mount,
							filteredFindHosts,
							disabledHosts,
						);
					default:
						return errorResponse(id, -32601, `Method not found: ${message.method}`);
				}
			} catch (error) {
				return errorResponse(id, -32603, error instanceof Error ? error.message : String(error));
			}
		},
	};
}

async function handleToolCall(
	id: JsonRpcId,
	params: unknown,
	execute: (args: SshExecArgs) => Promise<SshExecResult>,
	mount: (args: SshMountArgs) => Promise<SshMountResult>,
	findHosts: (pattern: string) => Promise<SshHostRecord[]>,
	disabledHosts: Set<string>,
): Promise<JsonRpcResponse> {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		return errorResponse(id, -32602, "tools/call params must be an object");
	}

	const record = params as Record<string, unknown>;
	if (record.name === "ssh_host") {
		try {
			const pattern = validateSshHostPattern(record.arguments);
			const hosts = await findHosts(pattern);
			return resultResponse(id, toolResultFromHostLookup(pattern, hosts));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return resultResponse(id, {
				isError: true,
				content: [{ type: "text", text: message }],
				structuredContent: { hosts: [] } satisfies SshHostStructuredContent,
			});
		}
	}

	if (record.name === "ssh_mount") {
		let args: SshMountArgs;
		try {
			args = validateSshMountArgs(record.arguments);
		} catch (error) {
			return errorResponse(id, -32602, error instanceof Error ? error.message : String(error));
		}
		if (disabledHosts.has(args.host)) {
			return resultResponse(id, disabledHostToolResult(args.host));
		}

		try {
			const result = await mount(args);
			return resultResponse(id, toolResultFromMount(result));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return resultResponse(id, {
				isError: true,
				content: [{ type: "text", text: message }],
			});
		}
	}

	if (record.name !== "ssh_exec") {
		return errorResponse(id, -32602, "Unknown tool");
	}

	let args: SshExecArgs;
	try {
		args = validateSshExecArgs(record.arguments);
	} catch (error) {
		return errorResponse(id, -32602, error instanceof Error ? error.message : String(error));
	}
	if (disabledHosts.has(args.host)) {
		return resultResponse(id, disabledHostToolResult(args.host));
	}

	try {
		const result = await execute(args);
		return resultResponse(
			id,
			toolResultFromSsh(result, result.exitCode !== 0 || result.exitCode === null),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return resultResponse(id, {
			isError: true,
			content: [{ type: "text", text: message }],
			structuredContent: {
				host: args.host,
				exitCode: null,
				durationMs: 0,
				truncated: false,
				notice: message,
			} satisfies SshExecStructuredContent,
		});
	}
}

function toolResultFromSsh(result: SshExecResult, isError: boolean) {
	const notice =
		result.notice ??
		(isError && result.exitCode !== null && result.exitCode !== 0
			? `Command exited with code ${result.exitCode}`
			: undefined);
	const outputText = result.output ?? `${result.stdout}${result.stderr}`;
	const displayOutput = outputText ? outputText.trimEnd() : "(no output)";
	const text = notice ? `${displayOutput}\n\n${notice}` : outputText || "(no output)";

	const payload: Record<string, unknown> = {
		content: [{ type: "text", text }],
		structuredContent: structuredContentFromSsh(result, notice),
	};
	if (isError) payload.isError = true;
	return payload;
}

function structuredContentFromSsh(
	result: SshExecResult,
	notice?: string,
): SshExecStructuredContent {
	return {
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
	};
}

function toolResultFromMount(result: SshMountResult) {
	const displayPath = ensureTrailingSlash(formatDisplayPath(result.localPath));
	const text = ["Success.", `Local path: ${displayPath}`, `Home path: ${displayPath}...`].join(
		"\n",
	);
	return {
		content: [{ type: "text", text }],
		structuredContent: {
			host: result.host,
			localPath: result.localPath,
			status: result.status,
		} satisfies SshMountStructuredContent,
	};
}

function toolResultFromHostLookup(pattern: string, hosts: SshHostRecord[]) {
	const text =
		hosts.length > 0 ? hosts.map((host) => host.display).join("\n") : `No \`${pattern}\` host.`;
	return {
		content: [{ type: "text", text }],
		structuredContent: { hosts } satisfies SshHostStructuredContent,
	};
}

function disabledHostsFromEnv(): string[] {
	const raw = process.env.SSH_EXEC_DISABLED_HOSTS?.trim() ?? "";
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed))
			return parsed.filter(
				(host): host is string => typeof host === "string" && host.trim() !== "",
			);
	} catch {
		// Keep accepting the old comma/whitespace form for compatibility.
	}

	return raw
		.split(/[,\s]+/)
		.map((host) => host.trim())
		.filter(Boolean);
}

function filterDisabledHosts(hosts: SshHostRecord[], disabledHosts: Set<string>): SshHostRecord[] {
	if (disabledHosts.size === 0) return hosts;
	return hosts.filter((host) => !disabledHosts.has(host.alias));
}

function disabledHostToolResult(host: string) {
	return {
		isError: true,
		content: [{ type: "text", text: `SSH host ${host} is disabled by SSH_EXEC_DISABLED_HOSTS.` }],
		structuredContent: { host, disabled: true },
	};
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

function requestedProtocolVersion(params: unknown): string {
	if (!params || typeof params !== "object" || Array.isArray(params)) return PROTOCOL_VERSION;
	const version = (params as Record<string, unknown>).protocolVersion;
	return typeof version === "string" && version.trim() ? version : PROTOCOL_VERSION;
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function errorResponse(
	id: JsonRpcId,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcResponse {
	const error: JsonRpcResponse["error"] = { code, message };
	if (data !== undefined) error.data = data;
	return { jsonrpc: "2.0", id, error };
}

export async function runCleanupSshProcess(
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

export async function runStdio(server: ReturnType<typeof createMcpServer>): Promise<void> {
	process.stdin.setEncoding("utf8");
	let buffer = "";

	for await (const chunk of process.stdin) {
		buffer += chunk;
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			await handleLine(server, line);
			newlineIndex = buffer.indexOf("\n");
		}
	}

	if (buffer.trim()) await handleLine(server, buffer);
}

async function handleLine(server: ReturnType<typeof createMcpServer>, line: string): Promise<void> {
	if (!line.trim()) return;

	let response: JsonRpcResponse | undefined;
	try {
		response = await server.handle(JSON.parse(line));
	} catch (error) {
		response = errorResponse(
			null,
			-32700,
			"Parse error",
			error instanceof Error ? error.message : String(error),
		);
	}

	if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (import.meta.main) {
	const server = createMcpServer();
	const runner = (args: string[], timeoutMs?: number) =>
		runCleanupSshProcess(server.manager.sshBin, args, timeoutMs, server.manager.sensitiveValues());

	let cleanupPromise: Promise<void> | undefined;
	const cleanup = async (budgetMs = 1_500) => {
		cleanupPromise ??= Promise.race([
			server.manager.closeAll(runner, Math.min(1_000, budgetMs)),
			new Promise<void>((resolve) => setTimeout(resolve, budgetMs)),
		]).then(() => undefined);
		await cleanupPromise;
	};

	process.once("beforeExit", () => {
		void cleanup();
	});
	process.on("SIGINT", () => {
		void cleanup().finally(() => process.exit(130));
	});
	process.on("SIGTERM", () => {
		void cleanup().finally(() => process.exit(143));
	});

	runStdio(server)
		.then(async () => {
			await cleanup();
			process.exit(0);
		})
		.catch((error) => {
			process.stderr.write(
				`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
			);
			process.exit(1);
		});
}
