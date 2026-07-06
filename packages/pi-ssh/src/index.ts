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
import { SessionManager } from "./scripts/session-manager.js";
import { createMcpServer } from "./scripts/ssh-exec-mcp.js";
import { findConfiguredHosts, type SshHostRecord } from "./scripts/ssh-hosts.js";

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
	let server = createServer(settings);

	const applySettings = (nextSettings: SshExtensionSettings): void => {
		settings = nextSettings;
		server = createServer(settings);
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
			const response = await server.handle({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "ssh_host", arguments: params },
			});
			return normalizePiToolResult(response);
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
			if (isHostDisabled(params.host)) return disabledHostResult(params.host);
			const response = await server.handle({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "ssh_mount", arguments: params },
			});
			return normalizePiToolResult(response);
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
			if (isHostDisabled(params.host)) return disabledHostResult(params.host);
			const response = await server.handle({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "ssh_exec",
					arguments: { ...params, timeout: params.timeout ?? settings.commandTimeoutSeconds },
				},
			});
			return normalizePiToolResult(response);
		},
	});
}

function createServer(settings: SshExtensionSettings) {
	return createMcpServer({
		manager: new SessionManager({
			controlPersist: String(settings.controlPersistSeconds),
			serverAliveIntervalSeconds: settings.serverAliveIntervalSeconds,
			serverAliveCountMax: settings.serverAliveCountMax,
		}),
		findHosts: async (pattern) => filterDisabledHosts(await findConfiguredHosts(pattern), settings),
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
