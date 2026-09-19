import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaunchSpec } from "./launch-spec.js";

const execFileAsync = promisify(execFile);

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
export type HostSelectionAttempt = HostCapability;

export type HostSelection =
	| {
			readonly available: true;
			readonly selectedHost: HostKind;
			readonly adapter: HostAdapter;
			readonly explicit: boolean;
			readonly reason: string;
			readonly attempts: readonly HostSelectionAttempt[];
	  }
	| {
			readonly available: false;
			readonly selectedHost: null;
			readonly explicit: boolean;
			readonly reason: string;
			readonly attempts: readonly HostSelectionAttempt[];
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
	const attempts: HostSelectionAttempt[] = [];
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
	readonly result: HostCommandResult;

	constructor(message: string, result: HostCommandResult) {
		super(message);
		this.name = "HostCommandError";
		this.result = result;
	}
}

export const systemHostCommandRunner: HostCommandRunner = {
	async run(command, args, options = {}): Promise<HostCommandResult> {
		try {
			const result = await execFileAsync(command, [...args], {
				timeout: options.timeoutMs,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			});
			return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, timedOut: false };
		} catch (error) {
			const value = error as NodeJS.ErrnoException & {
				stdout?: string;
				stderr?: string;
				code?: number | string;
				killed?: boolean;
				timedOut?: boolean;
			};
			return {
				stdout: value.stdout ?? "",
				stderr: value.stderr ?? value.message ?? String(error),
				exitCode: typeof value.code === "number" ? value.code : null,
				timedOut: value.timedOut === true || value.killed === true,
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
			if (process.env.HERDR_ENV !== "1")
				return { host: "herdr", available: false, reason: "HERDR_ENV is not 1" };
			const current = await runner.run("herdr", ["pane", "current", "--current"], { timeoutMs });
			if (current.timedOut)
				return { host: "herdr", available: false, reason: "herdr pane probe timed out" };
			if (current.exitCode !== 0)
				return {
					host: "herdr",
					available: false,
					reason: `herdr pane probe failed: ${current.stderr}`,
				};
			const pane = parseHerdrPaneId(current.stdout);
			return pane === undefined
				? { host: "herdr", available: false, reason: "herdr probe returned no current pane id" }
				: { host: "herdr", available: true, reason: `current pane ${pane}` };
		},
		async attach(spec): Promise<HostAttachment> {
			const current = await runner.run("herdr", ["pane", "current", "--current"], { timeoutMs });
			const parentPane = parseHerdrPaneId(current.stdout);
			if (parentPane === undefined)
				throw new HostCommandError("herdr current pane unavailable", current);
			const split = await runner.run(
				"herdr",
				[
					"pane",
					"split",
					"--pane",
					parentPane,
					"--direction",
					"right",
					"--cwd",
					spec.cwd,
					"--no-focus",
				],
				{ timeoutMs },
			);
			const childPane = parseHerdrPaneId(split.stdout);
			if (childPane === undefined)
				throw new HostCommandError("herdr split returned no child pane id", split);
			const launch = await runner.run("herdr", ["pane", "run", childPane, shellCommand(spec)], {
				timeoutMs,
			});
			return hostAttachment({
				identity: { host: "herdr", attachmentId: childPane, createdBy: options.ownerId },
				launch,
				noun: "pane",
				observe: () => runner.run("herdr", ["pane", "get", childPane], { timeoutMs }),
				isAlive: (result) => result.exitCode === 0,
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
			if (ping.exitCode !== 0)
				return { host: "cmux", available: false, reason: `cmux unavailable: ${ping.stderr}` };
			const capabilities = await runner.run("cmux", ["capabilities", "--json"], { timeoutMs });
			if (capabilities.timedOut || capabilities.exitCode !== 0)
				return { host: "cmux", available: false, reason: "cmux capability query failed" };
			return { host: "cmux", available: true, reason: "cmux responded and exposed capabilities" };
		},
		async attach(spec): Promise<HostAttachment> {
			const launch = await runner.run(
				"cmux",
				["new-split", "right", "--cwd", spec.cwd, "--command", shellCommand(spec)],
				{ timeoutMs },
			);
			const attachmentId = parseCmuxSurfaceId(launch.stdout);
			if (attachmentId === undefined)
				throw new HostCommandError(
					"cmux split returned no surface id; process state is unknown",
					launch,
				);
			return hostAttachment({
				identity: { host: "cmux", attachmentId, createdBy: options.ownerId },
				launch,
				noun: "surface",
				observe: () => runner.run("cmux", ["list-panels", "--json"], { timeoutMs }),
				isAlive: (result) => result.exitCode === 0 && containsString(result.stdout, attachmentId),
				close: () =>
					runner.run("cmux", ["close-surface", "--surface", attachmentId], { timeoutMs }),
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
			alive: options.isAlive(result),
			known: !result.timedOut,
			detail: result.stderr || result.stdout,
		};
	};
	return {
		identity: options.identity,
		launch: options.launch,
		observe,
		async cleanup(): Promise<HostCommandResult> {
			if (!options.ownsAttachment(options.identity))
				return failedResult(`${options.noun} ownership was revoked`);
			const observed = await observe();
			if (!options.ownsAttachment(options.identity))
				return failedResult(`${options.noun} ownership was revoked during observation`);
			if (!observed.known || !observed.alive)
				return failedResult(`${options.noun} is no longer owned or observable`);
			return options.close();
		},
	};
}

function shellCommand(spec: LaunchSpec): string {
	const environment = Object.entries(spec.env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");
	return [environment, shellQuote(spec.command), ...spec.argv.map(shellQuote)]
		.filter(Boolean)
		.join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
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
	return parseJsonId(output, ["surface_id", "surfaceId", "id"]);
}

function parseJsonId(output: string, keys: readonly string[]): string | undefined {
	try {
		const value: unknown = JSON.parse(output);
		return findString(value, keys);
	} catch {
		return undefined;
	}
}

function findString(value: unknown, keys: readonly string[]): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		const found = findString(child, keys);
		if (found !== undefined) return found;
	}
	return undefined;
}

function failedResult(message: string): HostCommandResult {
	return { stdout: "", stderr: message, exitCode: null, timedOut: false };
}
