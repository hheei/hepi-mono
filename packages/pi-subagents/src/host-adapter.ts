import { errorMessage, runCommand, shellQuote } from "@hheei/pi-ext-core";
import type { LaunchSpec } from "./launch-spec.js";

export type HostKind = "herdr" | "cmux";

/** Where a host command failed: session/env, layout, or the launch command itself. */
export type HostFailureClass = "environment" | "pane" | "command";

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
			readonly explicit: boolean;
			readonly reason: string;
			readonly attempts: readonly HostCapability[];
	  }
	| {
			readonly available: false;
			readonly selectedHost: null;
			readonly explicit: boolean;
			readonly reason: string;
			readonly attempts: readonly HostCapability[];
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
	readonly detail: string;
}

export interface HostAttachment {
	readonly identity: HostAttachmentIdentity;
	readonly launch: HostCommandResult;
	observe(): Promise<HostObservation>;
	cleanup(): Promise<HostCommandResult>;
}

export interface HostAdapter {
	readonly kind: HostKind;
	probe(): Promise<HostCapability>;
	attach(spec: LaunchSpec): Promise<HostAttachment>;
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
				explicit,
				reason:
					priorFailures === ""
						? `${explicit ? "explicit" : "default"} host ${host} is available`
						: `selected ${host} after ${priorFailures}`,
				attempts,
			};
		}
	}
	const failure = attempts.map((attempt) => `${attempt.host}: ${attempt.reason}`).join("; ");
	return {
		available: false,
		selectedHost: null,
		explicit,
		reason: explicit
			? `explicit host unavailable: ${failure}`
			: `no presentation host available: ${failure}`,
		attempts,
	};
}

export class HostCommandError extends Error {
	readonly kind: HostFailureClass;
	readonly result: HostCommandResult;

	constructor(kind: HostFailureClass, message: string, result: HostCommandResult) {
		super(message);
		this.name = "HostCommandError";
		this.kind = kind;
		this.result = result;
	}
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
		async attach(spec): Promise<HostAttachment> {
			const current = await runner.run("herdr", ["pane", "current", "--current"], { timeoutMs });
			const parentPane = parseHerdrPaneId(current.stdout);
			if (parentPane === undefined) {
				throw new HostCommandError("pane", "herdr current pane unavailable", current);
			}
			const split = await runner.run("herdr", herdrSplitArgs(parentPane, spec), { timeoutMs });
			const childPane = parseHerdrPaneId(split.stdout);
			if (childPane === undefined) {
				throw new HostCommandError("pane", "herdr split returned no child pane id", split);
			}
			// pane run sends text+Enter to the new shell. Timeout is not rollback: the pane
			// already exists and the process may still start after the CLI deadline.
			const launch = await runner.run(
				"herdr",
				["pane", "run", childPane, quotedArgv(spec.command, spec.argv)],
				{ timeoutMs },
			);
			return hostAttachment({
				identity: { host: "herdr", attachmentId: childPane, createdBy: options.ownerId },
				launch,
				noun: "pane",
				observe: () =>
					runner.run("herdr", ["pane", "process-info", "--pane", childPane], { timeoutMs }),
				isAlive: (result) => result.exitCode === 0 && herdrChildProcessIsRunning(result.stdout),
				close: () => runner.run("herdr", ["pane", "close", childPane], { timeoutMs }),
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
		async attach(spec): Promise<HostAttachment> {
			const launch = await runner.run(
				"cmux",
				["--json", "new-split", "right", "--command", cmuxLaunchCommand(spec)],
				{ timeoutMs },
			);
			const attachmentId = parseCmuxSurfaceId(launch.stdout);
			if (attachmentId === undefined) {
				throw new HostCommandError(
					"pane",
					"cmux split returned no surface id; process state is unknown",
					launch,
				);
			}
			return hostAttachment({
				identity: { host: "cmux", attachmentId, createdBy: options.ownerId },
				launch,
				noun: "surface",
				observe: () => runner.run("cmux", ["--json", "list-panels"], { timeoutMs }),
				isAlive: (result) => result.exitCode === 0 && containsString(result.stdout, attachmentId),
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
	readonly noun: "pane" | "surface";
	readonly observe: () => Promise<HostCommandResult>;
	readonly isAlive: (result: HostCommandResult) => boolean;
	readonly close: () => Promise<HostCommandResult>;
	readonly ownsAttachment: (identity: HostAttachmentIdentity) => boolean;
}

function hostAttachment(options: HostAttachmentOptions): HostAttachment {
	const observe = async (): Promise<HostObservation> => {
		const result = await options.observe();
		return {
			identity: options.identity,
			alive: !result.timedOut && options.isAlive(result),
			known: !result.timedOut,
			detail: result.stderr || result.stdout,
		};
	};
	return {
		identity: options.identity,
		launch: options.launch,
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

function herdrSplitArgs(parentPane: string, spec: LaunchSpec): string[] {
	const args = [
		"pane",
		"split",
		"--pane",
		parentPane,
		"--direction",
		"right",
		"--cwd",
		spec.cwd,
		"--no-focus",
	];
	for (const [key, value] of Object.entries(spec.env)) {
		args.push("--env", `${key}=${value}`);
	}
	return args;
}

/** Herdr `pane run` concatenates extra argv with spaces, so quoting happens here once. */
function quotedArgv(command: string, argv: readonly string[]): string {
	return [command, ...argv].map(shellQuote).join(" ");
}

/**
 * cmux `new-split --command` is shell text. Encode cwd + env + argv without inventing Pi flags.
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
