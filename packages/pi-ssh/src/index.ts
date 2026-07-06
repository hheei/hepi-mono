import { homedir } from "node:os";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type ExtensionAPI,
	getSettingsListTheme,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
	registerExtensionSettings,
	type SettingGroup,
	type SettingsState,
} from "@hheei/pi-extcore";
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
	disabledHosts: string[];
}

const DEFAULT_SETTINGS: SshExtensionSettings = {
	commandTimeoutSeconds: 10,
	controlPersistSeconds: 3600,
	serverAliveIntervalSeconds: 300,
	serverAliveCountMax: 3,
	disabledHosts: [],
};

const SSH_SETTING_GROUPS: SettingGroup[] = [
	{
		id: "connection",
		title: "Connection",
		display: "plain",
		fields: [
			{
				id: "commandTimeoutSeconds",
				label: "Default command timeout",
				defaultValue: DEFAULT_SETTINGS.commandTimeoutSeconds,
				description: "Default timeout for ssh_exec when the tool call does not pass timeout",
				options: secondsOptions([5, 10, 30, 60, 120, 300, 600]),
			},
			{
				id: "controlPersistSeconds",
				label: "ControlMaster alive",
				defaultValue: DEFAULT_SETTINGS.controlPersistSeconds,
				description: "SSH ControlPersist lifetime for reused master connections",
				options: secondsOptions([300, 600, 1800, 3600, 7200]),
			},
			{
				id: "serverAliveIntervalSeconds",
				label: "Alive interval",
				defaultValue: DEFAULT_SETTINGS.serverAliveIntervalSeconds,
				description: "ServerAliveInterval seconds for ssh and sshfs connections",
				options: secondsOptions([30, 60, 120, 300, 600]),
			},
			{
				id: "serverAliveCountMax",
				label: "Alive retry count",
				defaultValue: DEFAULT_SETTINGS.serverAliveCountMax,
				description: "ServerAliveCountMax before SSH treats the connection as dead",
				options: [1, 2, 3, 5, 10].map((value) => ({ value, label: String(value) })),
			},
		],
	},
	{
		id: "hosts",
		title: "Hosts",
		display: "hidden",
		fields: [
			{
				id: "disabledHosts",
				label: "Disabled hosts",
				defaultValue: "",
			},
		],
	},
];

export default function register(pi: ExtensionAPI) {
	let settings = DEFAULT_SETTINGS;
	let manager = createManager(settings);

	const applySettings = (nextSettings: SshExtensionSettings): void => {
		settings = nextSettings;
		manager = createManager(settings);
	};

	const isHostDisabled = (host: string): boolean => settings.disabledHosts.includes(host);

	registerExtensionSettings(pi, {
		id: "pi-ssh",
		title: "PI SSH",
		description: "SSH host discovery, remote exec, and sshfs mount tools",
		groups: SSH_SETTING_GROUPS,
		panels: [
			{
				id: "hosts",
				label: "Hosts",
				description: "Enable or disable OpenSSH config hosts",
				currentValue: "open",
				create: (options) =>
					createSshHostsPanel(
						options.host,
						options.theme,
						options.close,
						options.onError,
						() => settings,
						async (nextSettings) => {
							await options.saveState(sshStateFromSettings(nextSettings));
							applySettings(nextSettings);
							options.host.requestRender();
						},
					),
			},
		],
		onLoad: (state) => {
			applySettings(sshSettingsFromState(state));
		},
		onChange: (change) => {
			applySettings(sshSettingsFromState(change.state));
		},
	});

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
				const hosts = filterDisabledHosts(await findConfiguredHosts(pattern), settings);
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
			if (isHostDisabled(args.host)) return disabledHostResult(args.host);
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
			text += theme.fg("dim", ` (timeout: ${args.timeout ?? settings.commandTimeoutSeconds}s)`);

			text += `\n${theme.fg("bashMode", `$ ${args.command}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult: renderCollapsedResult,
		async execute(_id, params) {
			const args = validateSshExecArgs({
				...(params as Record<string, unknown>),
				timeout: (params as { timeout?: number }).timeout ?? settings.commandTimeoutSeconds,
			});
			if (isHostDisabled(args.host)) return disabledHostResult(args.host);
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

function filterDisabledHosts(
	hosts: SshHostRecord[],
	settings: SshExtensionSettings,
): SshHostRecord[] {
	const disabled = new Set(settings.disabledHosts);
	return hosts.filter((host) => !disabled.has(host.alias));
}

function disabledHostResult(host: string): SshToolResult {
	return {
		content: [{ type: "text", text: `SSH host ${host} is disabled by /extension-setting.` }],
		details: { host, disabled: true },
	};
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

function createSshHostsPanel(
	host: { requestRender(): void },
	theme: Theme,
	close: () => void,
	onError: (error: unknown) => void,
	getSettings: () => SshExtensionSettings,
	onChange: (settings: SshExtensionSettings) => Promise<void>,
) {
	const container = new Container();
	container.addChild(new Text(theme.fg("accent", theme.bold("SSH Hosts")), 0, 0));
	container.addChild(
		new Text(theme.fg("dim", "Enter/Space toggles host availability · Esc closes"), 0, 0),
	);

	let settingsList = new SettingsList([], 8, getSettingsListTheme(), () => {}, close, {
		enableSearch: true,
	});
	void rebuildItems().catch(onError);
	container.addChild({
		render: (width) => settingsList.render(width),
		invalidate: () => settingsList.invalidate(),
		handleInput: (data) => settingsList.handleInput(data),
	});

	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => settingsList.handleInput(data),
	};

	async function rebuildItems(): Promise<void> {
		const hosts = await findConfiguredHosts("*");
		settingsList = new SettingsList(
			sshHostItems(getSettings(), hosts),
			Math.min(Math.max(hosts.length, 8), 20),
			getSettingsListTheme(),
			(id, newValue) => {
				const previousSettings = getSettings();
				const nextSettings = updateHostSetting(getSettings(), id, newValue);
				void onChange(nextSettings)
					.then(() => settingsList.updateValue(id, newValue))
					.catch(() => {
						settingsList.updateValue(id, hostSettingValue(previousSettings, id));
						host.requestRender();
					});
			},
			close,
			{ enableSearch: true },
		);
		host.requestRender();
	}
}

function sshHostItems(settings: SshExtensionSettings, hosts: SshHostRecord[]): SettingItem[] {
	const disabled = new Set(settings.disabledHosts);
	return hosts.map((host) => ({
		id: `host:${host.alias}`,
		label: `@${host.alias}`,
		description: host.display,
		currentValue: disabled.has(host.alias) ? "disabled" : "enabled",
		values: ["enabled", "disabled"],
	}));
}

function hostSettingValue(settings: SshExtensionSettings, id: string): "enabled" | "disabled" {
	const host = id.startsWith("host:") ? id.slice("host:".length) : "";
	return settings.disabledHosts.includes(host) ? "disabled" : "enabled";
}

function updateHostSetting(
	settings: SshExtensionSettings,
	id: string,
	newValue: string,
): SshExtensionSettings {
	if (!id.startsWith("host:")) return settings;
	const host = id.slice("host:".length);
	const disabled = new Set(settings.disabledHosts);
	if (newValue === "disabled") disabled.add(host);
	else disabled.delete(host);
	return { ...settings, disabledHosts: sorted(disabled) };
}
function sshStateFromSettings(settings: SshExtensionSettings): SettingsState {
	return {
		connection: {
			commandTimeoutSeconds: settings.commandTimeoutSeconds,
			controlPersistSeconds: settings.controlPersistSeconds,
			serverAliveIntervalSeconds: settings.serverAliveIntervalSeconds,
			serverAliveCountMax: settings.serverAliveCountMax,
		},
		hosts: {
			disabledHosts: settings.disabledHosts,
		},
	};
}

function sshSettingsFromState(state: SettingsState | undefined): SshExtensionSettings {
	const connection = state?.connection ?? {};
	return {
		commandTimeoutSeconds: clampInt(
			connection.commandTimeoutSeconds,
			DEFAULT_SETTINGS.commandTimeoutSeconds,
			1,
			3600,
		),
		controlPersistSeconds: clampInt(
			connection.controlPersistSeconds,
			DEFAULT_SETTINGS.controlPersistSeconds,
			1,
			86_400,
		),
		serverAliveIntervalSeconds: clampInt(
			connection.serverAliveIntervalSeconds,
			DEFAULT_SETTINGS.serverAliveIntervalSeconds,
			1,
			3600,
		),
		serverAliveCountMax: clampInt(
			connection.serverAliveCountMax,
			DEFAULT_SETTINGS.serverAliveCountMax,
			1,
			100,
		),
		disabledHosts: parseDisabledHosts(state?.hosts?.disabledHosts),
	};
}

function parseDisabledHosts(value: unknown): string[] {
	if (Array.isArray(value)) return sorted(value.filter((item) => typeof item === "string"));
	if (typeof value !== "string") return [];
	return sorted(
		value
			.split(/\r?\n/)
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

function secondsOptions(values: readonly number[]) {
	return values.map((value) => ({ value, label: `${value}s` }));
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function sorted(names: Iterable<string>): string[] {
	return [...new Set(names)].sort((a, b) => a.localeCompare(b));
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

function normalizePiToolResult(response: unknown): SshToolResult {
	const result = (response as { result?: Record<string, unknown> }).result ?? {};
	const content = normalizeToolContent(result.content);
	const details = (result.structuredContent ?? {}) as Record<string, unknown>;
	return {
		content,
		details,
	};
}

function normalizeToolContent(content: unknown): TextContent[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((item): TextContent[] => {
		if (!item || typeof item !== "object") return [];
		const record = item as Record<string, unknown>;
		if (record.type !== "text" || typeof record.text !== "string") return [];
		return [{ type: "text", text: record.text }];
	});
}
