import { errorMessage, runCommand, shellQuote } from "@hheei/pi-ext-core";
import type { LaunchSpec } from "./launch-spec.js";

export type HostKind = "herdr" | "cmux";

export interface HostCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
}

export interface HostCommandRunner {
	run(
		command: string,
		args: readonly string[],
		options?: { readonly timeoutMs?: number },
	): Promise<HostCommandResult>;
}

export interface HostCapability {
	readonly host: HostKind;
	readonly available: boolean;
	readonly reason: string;
}

export type HostSelection =
	| {
			readonly available: true;
			readonly selectedHost: HostKind;
			readonly adapter: HostAdapter;
			readonly reason: string;
	  }
	| {
			readonly available: false;
			readonly selectedHost: null;
			readonly reason: string;
	  };

export interface HostAttachmentIdentity {
	readonly host: HostKind;
	readonly attachmentId: string;
	readonly createdBy: string;
}

export interface HostObservation {
	readonly identity: HostAttachmentIdentity;
	readonly alive: boolean;
	readonly known: boolean;
	/**
	 * Whether a human is looking at this panel. Absent when the host cannot say, which includes
	 * both hosts without the capability and a lookup that failed just now; the caller must treat
	 * an absent answer as "do not touch", because an unfocused answer lets it close the panel.
	 */
	readonly focused?: boolean;
	readonly detail: string;
}

export interface HostAttachment {
	readonly identity: HostAttachmentIdentity;
	readonly launch: HostCommandResult;
	/** True when `observe()` can report focus; idle reclaim needs it and fails open without it. */
	readonly reportsFocus: boolean;
	observe(): Promise<HostObservation>;
	cleanup(): Promise<HostCommandResult>;
}

export interface HostAdapter {
	readonly kind: HostKind;
	probe(): Promise<HostCapability>;
	/** Opens the child's panel and runs the LaunchSpec in it. */
	open(spec: LaunchSpec): Promise<HostAttachment>;
}

export interface SelectHostAdapterOptions {
	readonly adapters: Readonly<Record<HostKind, HostAdapter>>;
	readonly preferredHost?: HostKind;
}

const DEFAULT_HOST_ORDER: readonly HostKind[] = ["herdr", "cmux"];

/** Selects a presentation host visibly; an explicit unavailable host never falls back. */
export async function selectHostAdapter(options: SelectHostAdapterOptions): Promise<HostSelection> {
	const explicit = options.preferredHost !== undefined;
	const order = explicit ? [options.preferredHost] : DEFAULT_HOST_ORDER;
	const attempts: HostCapability[] = [];
	for (const host of order) {
		const adapter = options.adapters[host];
		const capability = await adapter.probe();
		attempts.push(capability);
		if (capability.available) {
			const priorFailures = attempts
				.slice(0, -1)
				.map((attempt) => `${attempt.host}: ${attempt.reason}`)
				.join("; ");
			return {
				available: true,
				selectedHost: host,
				adapter,
				reason:
					priorFailures === ""
						? `${explicit ? "explicit" : "default"} host ${host} is available`
						: `selected ${host} after ${priorFailures}`,
			};
		}
	}
	const failure = attempts.map((attempt) => `${attempt.host}: ${attempt.reason}`).join("; ");
	return {
		available: false,
		selectedHost: null,
		reason: explicit
			? `explicit host unavailable: ${failure}`
			: `no presentation host available: ${failure}`,
	};
}

const HOST_COMMAND_MAX_STDOUT_BYTES = 1024 * 1024;

function errnoCode(error: unknown): string | undefined {
	// Node's spawn errors are plain Errors carrying a `code` string; narrowing here
	// keeps the ENOENT decision below honest about the caught value being unknown.
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export const systemHostCommandRunner: HostCommandRunner = {
	async run(command, args, options = {}): Promise<HostCommandResult> {
		try {
			const result = await runCommand(command, [...args], {
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				maxStdoutBytes: HOST_COMMAND_MAX_STDOUT_BYTES,
			});
			return {
				stdout: result.stdout.toString("utf8"),
				stderr: result.stdoutTruncated
					? `output exceeded ${HOST_COMMAND_MAX_STDOUT_BYTES} bytes`
					: result.stderr.toString("utf8"),
				// A command killed by a signal reports no exit code; the kill still counts as
				// a failure through `timedOut` or `hostCleanupFailed`.
				exitCode: result.signal === null ? result.code : null,
				timedOut: result.timedOut,
			};
		} catch (error) {
			if (errnoCode(error) === "ENOENT") {
				return {
					stdout: "",
					stderr: `command not found: ${command}`,
					exitCode: 127,
					timedOut: false,
				};
			}
			return {
				stdout: "",
				stderr: errorMessage(error),
				exitCode: null,
				timedOut: false,
			};
		}
	},
};

export interface HostAdapterOptions {
	readonly runner?: HostCommandRunner;
	readonly ownerId: string;
	readonly ownsAttachment: (identity: HostAttachmentIdentity) => boolean;
	readonly timeoutMs?: number;
	readonly env?: NodeJS.ProcessEnv;
}

export function createHerdrHostAdapter(options: HostAdapterOptions): HostAdapter {
	const runner = options.runner ?? systemHostCommandRunner;
	const timeoutMs = options.timeoutMs ?? 10_000;
	return {
		kind: "herdr",
		async probe(): Promise<HostCapability> {
			if (process.env.HERDR_ENV !== "1") {
				return { host: "herdr", available: false, reason: "HERDR_ENV is not 1" };
			}
			const current = await runner.run("herdr", ["pane", "current", "--current"], { timeoutMs });
			if (current.timedOut) {
				return { host: "herdr", available: false, reason: "herdr pane probe timed out" };
			}
			if (current.exitCode === 127) {
				return { host: "herdr", available: false, reason: current.stderr };
			}
			if (current.exitCode !== 0) {
				return {
					host: "herdr",
					available: false,
					reason: `herdr pane probe failed: ${current.stderr}`,
				};
			}
			const pane = parseHerdrPaneId(current.stdout);
			return pane === undefined
				? { host: "herdr", available: false, reason: "herdr probe returned no current pane id" }
				: { host: "herdr", available: true, reason: `current pane ${pane}` };
		},
		async open(spec): Promise<HostAttachment> {
			// A dedicated tab, not a split of the parent pane: the child TUI owns its own tab, the
			// parent session keeps its layout and focus, and the tab is labeled with the child id so
			// a human can tell whose panel it is.
			const workspaceId = await resolveHerdrProcessWorkspaceId(
				runner,
				timeoutMs,
				options.env ?? process.env,
			);
			const created = await runner.run("herdr", herdrTabCreateArgs(spec, workspaceId), {
				timeoutMs,
			});
			const target = parseHerdrTab(created.stdout);
			if (target === undefined) {
				throw new Error("herdr tab create returned no tab and root pane id");
			}
			// pane run sends text+Enter to the tab's root shell. Timeout is not rollback: the tab
			// already exists and the process may still start after the CLI deadline.
			const launch = await runner.run(
				"herdr",
				["pane", "run", target.paneId, quotedArgv(spec.command, spec.argv)],
				{ timeoutMs },
			);
			return hostAttachment({
				identity: { host: "herdr", attachmentId: target.tabId, createdBy: options.ownerId },
				launch,
				noun: "tab",
				reportsFocus: true,
				observe: async () => {
					// Aliveness is the pane's foreground process; focus is a fact about the tab *and*
					// its workspace, so both listings are read together with it.
					const [process, tabs, workspaces] = await Promise.all([
						runner.run("herdr", ["pane", "process-info", "--pane", target.paneId], { timeoutMs }),
						runner.run("herdr", ["tab", "list"], { timeoutMs }),
						runner.run("herdr", ["workspace", "list"], { timeoutMs }),
					]);
					// A listing that did not answer says nothing about focus: reading it anyway turns a
					// failed command into "unfocused", and the caller closes a panel on that answer.
					const listed =
						herdrListingSucceeded(tabs) && herdrListingSucceeded(workspaces)
							? herdrPanelFocused(tabs.stdout, workspaces.stdout, target.tabId)
							: undefined;
					const alive = herdrPaneAlive(process);
					return {
						process,
						...(alive === undefined ? {} : { alive }),
						...(listed === undefined ? {} : { focused: listed }),
					};
				},
				close: () => runner.run("herdr", ["tab", "close", target.tabId], { timeoutMs }),
				ownsAttachment: options.ownsAttachment,
			});
		},
	};
}

export function createCmuxHostAdapter(options: HostAdapterOptions): HostAdapter {
	const runner = options.runner ?? systemHostCommandRunner;
	const timeoutMs = options.timeoutMs ?? 10_000;
	return {
		kind: "cmux",
		async probe(): Promise<HostCapability> {
			const ping = await runner.run("cmux", ["ping"], { timeoutMs });
			if (ping.timedOut) return { host: "cmux", available: false, reason: "cmux ping timed out" };
			if (ping.exitCode !== 0) {
				return { host: "cmux", available: false, reason: `cmux unavailable: ${ping.stderr}` };
			}
			const capabilities = await runner.run("cmux", ["capabilities", "--json"], { timeoutMs });
			if (capabilities.timedOut || capabilities.exitCode !== 0) {
				return { host: "cmux", available: false, reason: "cmux capability query failed" };
			}
			return { host: "cmux", available: true, reason: "cmux responded and exposed capabilities" };
		},
		async open(spec): Promise<HostAttachment> {
			const launch = await runner.run(
				"cmux",
				["--json", "new-surface", "--command", cmuxLaunchCommand(spec)],
				{ timeoutMs },
			);
			const attachmentId = parseCmuxSurfaceId(launch.stdout);
			if (attachmentId === undefined) {
				throw new Error("cmux new-surface returned no surface id; process state is unknown");
			}
			return hostAttachment({
				identity: { host: "cmux", attachmentId, createdBy: options.ownerId },
				launch,
				noun: "surface",
				// TODO(cmux-focus): cmux does not report which surface a human is looking at, so
				// observation cannot answer `focused` and idle reclaim fails open here: a cmux child
				// is only ever closed by stop_agent.
				reportsFocus: false,
				observe: async () => {
					const process = await runner.run("cmux", ["--json", "list-panels"], { timeoutMs });
					if (process.timedOut || process.exitCode !== 0) return { process };
					return { process, alive: containsString(process.stdout, attachmentId) };
				},
				close: () =>
					runner.run("cmux", ["--json", "close-surface", "--surface", attachmentId], {
						timeoutMs,
					}),
				ownsAttachment: options.ownsAttachment,
			});
		},
	};
}

interface HostAttachmentOptions {
	readonly identity: HostAttachmentIdentity;
	readonly launch: HostCommandResult;
	readonly noun: "pane" | "surface" | "tab";
	readonly reportsFocus: boolean;
	/** Reads the child's process state; `alive: undefined` means the host could not answer. */
	readonly observe: () => Promise<{
		readonly process: HostCommandResult;
		readonly alive?: boolean;
		readonly focused?: boolean;
	}>;
	readonly close: () => Promise<HostCommandResult>;
	readonly ownsAttachment: (identity: HostAttachmentIdentity) => boolean;
}

function hostAttachment(options: HostAttachmentOptions): HostAttachment {
	const observe = async (): Promise<HostObservation> => {
		const result = await options.observe();
		const focused = options.reportsFocus ? result.focused : undefined;
		return {
			identity: options.identity,
			// A host that could not answer is not reporting a dead child: `alive: false` is what lets
			// the caller drop the panel and the runtime evidence, so it is only ever said on purpose.
			alive: result.alive === true,
			known: result.alive !== undefined,
			...(focused === undefined ? {} : { focused }),
			detail: result.process.stderr || result.process.stdout,
		};
	};
	return {
		identity: options.identity,
		launch: options.launch,
		reportsFocus: options.reportsFocus,
		observe,
		async cleanup(): Promise<HostCommandResult> {
			if (!options.ownsAttachment(options.identity)) {
				return failedResult(`${options.noun} ownership was revoked`);
			}
			const observed = await observe();
			if (!options.ownsAttachment(options.identity)) {
				return failedResult(`${options.noun} ownership was revoked during observation`);
			}
			if (!observed.known) {
				return failedResult(`${options.noun} observation timed out; not closing`);
			}
			return options.close();
		},
	};
}

/**
 * Herdr tab creation carries cwd, env, label, and explicit workspace id matching the parent
 * process, ensuring the child tab spawns in the process's own workspace rather than whatever
 * workspace happens to have user focus.
 */
export function herdrTabCreateArgs(spec: LaunchSpec, workspaceId?: string): string[] {
	const args = [
		"tab",
		"create",
		"--cwd",
		spec.cwd,
		"--label",
		spec.config.subagentId,
		"--no-focus",
	];
	if (workspaceId !== undefined && workspaceId !== "") {
		args.push("--workspace", workspaceId);
	}
	for (const [key, value] of Object.entries(spec.env)) {
		args.push("--env", `${key}=${value}`);
	}
	return args;
}

export function parseHerdrWorkspaceId(output: string): string | undefined {
	return parseJsonId(output, ["workspace_id", "workspaceId"]);
}

/**
 * Resolves the workspace id of the current process so new tabs open in the same workspace.
 * Reads environment variables first, falling back to herdr pane queries.
 */
export async function resolveHerdrProcessWorkspaceId(
	runner: HostCommandRunner,
	timeoutMs: number,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	const envWorkspace = env.HERDR_WORKSPACE_ID?.trim();
	if (envWorkspace) return envWorkspace;
	const envPane = env.HERDR_PANE_ID?.trim();
	if (envPane) {
		const res = await runner.run("herdr", ["pane", "get", envPane], { timeoutMs });
		if (res.exitCode === 0) {
			const ws = parseHerdrWorkspaceId(res.stdout);
			if (ws) return ws;
		}
	}
	const current = await runner.run("herdr", ["pane", "current", "--current"], { timeoutMs });
	if (current.exitCode === 0) {
		return parseHerdrWorkspaceId(current.stdout);
	}
	return undefined;
}

/**
 * Focus is answered from two listings: `tab list` says whether the child's tab is focused and
 * which workspace owns it, `workspace list` says whether that workspace is the rendered one. A
 * child is being watched only when both are focused. Anything missing — a failed listing, an absent
 * field, a tab that is not there — is unknown, never "unfocused", because the caller closes a panel
 * on an unfocused answer.
 */
export function herdrPanelFocused(
	tabList: string,
	workspaceList: string,
	tabId: string,
): boolean | undefined {
	const tab = herdrListEntry(tabList, "tabs", "tab_id", tabId);
	if (tab === undefined) return undefined;
	const tabFocused = tab.focused;
	if (typeof tabFocused !== "boolean") return undefined;
	if (!tabFocused) return false;
	const workspaceId = tab.workspace_id;
	if (typeof workspaceId !== "string" || workspaceId === "") return undefined;
	const workspace = herdrListEntry(workspaceList, "workspaces", "workspace_id", workspaceId);
	const workspaceFocused = workspace?.focused;
	return typeof workspaceFocused === "boolean" ? workspaceFocused : undefined;
}

function herdrListEntry(
	output: string,
	collection: string,
	key: string,
	id: string,
): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
	const list = findNamedObject(parsed, "result")?.[collection];
	if (!Array.isArray(list)) return undefined;
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record[key] === id) return record;
	}
	return undefined;
}

/**
 * `herdr tab create` answers with the tab and its root pane: the pane runs the LaunchSpec and is
 * what observation watches, while the tab is what cleanup closes.
 */
function parseHerdrTab(
	output: string,
): { readonly tabId: string; readonly paneId: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
	const tabId = findNamedObject(parsed, "tab")?.tab_id;
	const paneId = findNamedObject(parsed, "root_pane")?.pane_id;
	if (typeof tabId !== "string" || typeof paneId !== "string") return undefined;
	return { tabId, paneId };
}

/** Herdr `pane run` concatenates extra argv with spaces, so quoting happens here once. */
function quotedArgv(command: string, argv: readonly string[]): string {
	return [command, ...argv].map(shellQuote).join(" ");
}

/**
 * cmux `new-surface --command` is shell text. Encode cwd + env + argv without inventing Pi flags.
 * A surface is cmux's own name for a panel: attaching adds one to the current pane instead of
 * splitting the parent's layout, and cleanup closes exactly that surface.
 */
function cmuxLaunchCommand(spec: LaunchSpec): string {
	const directory = `cd ${shellQuote(spec.cwd)}`;
	const environment = Object.entries(spec.env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");
	return [directory, "&&", environment, quotedArgv(spec.command, spec.argv)]
		.filter((part) => part.length > 0)
		.join(" ");
}

function containsString(output: string, target: string): boolean {
	try {
		return valueContainsString(JSON.parse(output) as unknown, target);
	} catch {
		return false;
	}
}

function valueContainsString(value: unknown, target: string): boolean {
	if (value === target) return true;
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).some((child) => valueContainsString(child, target));
}

function parseHerdrPaneId(output: string): string | undefined {
	return parseJsonId(output, ["pane_id"]);
}

function parseCmuxSurfaceId(output: string): string | undefined {
	const named = parseJsonId(output, ["surface_id", "surfaceId"]);
	if (named !== undefined) return named;
	const generic = parseJsonId(output, ["id"], (value) => !value.startsWith("cli:"));
	return generic;
}

function parseJsonId(
	output: string,
	keys: readonly string[],
	accept: (value: string) => boolean = () => true,
): string | undefined {
	try {
		return findString(JSON.parse(output) as unknown, keys, accept);
	} catch {
		return undefined;
	}
}

function findString(
	value: unknown,
	keys: readonly string[],
	accept: (value: string) => boolean,
): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "string" && candidate.length > 0 && accept(candidate)) {
			return candidate;
		}
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		const found = findString(child, keys, accept);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** A listing that failed or timed out is not evidence, whatever its stdout happens to contain. */
function herdrListingSucceeded(result: HostCommandResult): boolean {
	return !result.timedOut && result.exitCode === 0;
}

/**
 * Reads the pane's process state. A pane that no longer exists is a definite "not alive" — that is
 * how a closed panel looks — while a query that never ran or failed for any other reason is
 * unknown, because the caller closes the panel on "not alive".
 */
export function herdrPaneAlive(result: HostCommandResult): boolean | undefined {
	if (herdrListingSucceeded(result)) return herdrChildProcessIsRunning(result.stdout);
	// The CLI writes the error as JSON on stderr.
	const code = herdrErrorCode(result.stderr) ?? herdrErrorCode(result.stdout);
	if (code === "pane_not_found" || code === "tab_not_found") return false;
	return undefined;
}

/** The error code of a herdr CLI failure, which reports it as JSON. */
function herdrErrorCode(output: string): string | undefined {
	try {
		const parsed = JSON.parse(output) as { error?: { code?: unknown } };
		return typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
	} catch {
		return undefined;
	}
}

function herdrChildProcessIsRunning(output: string): boolean {
	try {
		const info = findNamedObject(JSON.parse(output) as unknown, "process_info");
		if (info === undefined) return false;
		const shellPid = typeof info.shell_pid === "number" ? info.shell_pid : undefined;
		const foreground = info.foreground_processes;
		if (!Array.isArray(foreground)) return false;
		return foreground.some((proc) => {
			if (typeof proc !== "object" || proc === null) return false;
			const pid = (proc as { pid?: unknown }).pid;
			return typeof pid === "number" && pid !== shellPid;
		});
	} catch {
		return false;
	}
}

function findNamedObject(value: unknown, name: string): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const direct = record[name];
	if (typeof direct === "object" && direct !== null) return direct as Record<string, unknown>;
	for (const child of Object.values(record)) {
		const found = findNamedObject(child, name);
		if (found !== undefined) return found;
	}
	return undefined;
}

function failedResult(message: string): HostCommandResult {
	return { stdout: "", stderr: message, exitCode: null, timedOut: false };
}
