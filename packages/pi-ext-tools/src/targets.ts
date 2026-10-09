import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { runCommand, setPromptSection } from "@hheei/pi-ext-core";

export const LOCAL_TARGET = "local";
export const REMOTE_TIMEOUT_MS = 20_000;
export const CONTROL_PERSIST = "15m";
const TARGET_PROMPT_SECTION = "pi-ext-tools-targets";
const TARGET_PROMPT_LINES = [
	"edit, and write accept target: local or an authorized SSH host. bash and apply_patch accept local or an authorized SSH host.",
	"Omitting target uses local. Remote targets are POSIX hosts. bash has no default timeout and does not support async. apply_patch, remote edit, and remote write files are capped at 32 MiB.",
] as const;

export type TargetOutcome =
	| "ok"
	| "non_persistent"
	| "unauthorized"
	| "dependency"
	| "cancelled"
	| "timeout"
	| "scope_too_broad";

type Notify = (message: string, level: "info" | "warning" | "error") => void;

type ProcessResult = {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly code: number;
	readonly timedOut: boolean;
};

type SessionManagerLike = object;

type TargetRuntimeOptions = {
	readonly sessionManager?: SessionManagerLike;
	readonly notify?: Notify;
	readonly home?: string;
	readonly sshConfigPath?: string;
};

export type RemoteFindCandidate = {
	readonly path: string;
	readonly matchType: "path" | "fuzzy";
	readonly score: number;
};

export function accessDeniedDiagnostics(stderr: string): readonly string[] | undefined {
	const diagnostics = stderr
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
	if (diagnostics.length === 0) return undefined;
	return diagnostics.every((diagnostic) =>
		/(?:\bEACCES\b|\bEPERM\b|\(os error (?:1|13)\)|permission denied|operation not permitted)/iu.test(
			diagnostic,
		),
	)
		? diagnostics
		: undefined;
}

export class RemoteGrepAccessDeniedError extends Error {
	readonly stdout: string;
	readonly diagnostics: readonly string[];

	constructor(stdout: string, diagnostics: readonly string[]) {
		super(diagnostics.join("\n"));
		this.name = "RemoteGrepAccessDeniedError";
		this.stdout = stdout;
		this.diagnostics = diagnostics;
	}
}

export class TargetError extends Error {
	readonly outcome: Exclude<TargetOutcome, "ok" | "non_persistent">;
	constructor(outcome: Exclude<TargetOutcome, "ok" | "non_persistent">, message: string) {
		super(message);
		this.name = "TargetError";
		this.outcome = outcome;
	}
}

export class RemoteScopeTooBroadError extends TargetError {
	readonly code = "remote_scope_too_broad";
	constructor() {
		super("scope_too_broad", "Remote find scope is too broad; narrow the path or pattern.");
	}
}

export function isTargetError(error: unknown): error is TargetError {
	return error instanceof TargetError;
}

export function isPosixUname(value: string): boolean {
	const name = value.trim().split(/\s+/u)[0] ?? "";
	return /^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|AIX)$/u.test(name);
}

export function rejectUnsupportedTarget(tool: string, params: unknown): void {
	if (typeof params !== "object" || params === null) return;
	const target = Reflect.get(params, "target");
	if (target === undefined || target === LOCAL_TARGET) return;
	throw new TargetError("unauthorized", `${tool} does not support remote targets.`);
}

function sftpQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function literalHostAliases(config: string): ReadonlySet<string> {
	const aliases = new Set<string>();
	for (const line of config.split(/\r?\n/u)) {
		const match = /^\s*Host\s+(.+)$/iu.exec(line);
		if (match === null) continue;
		const hosts = match[1];
		if (hosts === undefined) continue;
		for (const alias of hosts.split(/\s+/u)) {
			if (alias !== "" && !/[*!?]/u.test(alias)) aliases.add(alias);
		}
	}
	return aliases;
}

async function removeStaleControlSockets(root: string): Promise<void> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			await removeStaleControlSockets(path);
			continue;
		}
		if (!entry.name.endsWith(".sock")) continue;
		const check = await runProcess("ssh", ["-O", "check", "-o", `ControlPath=${path}`, "unused"], {
			timeoutMs: 2_000,
		}).catch(() => undefined);
		if (check?.code === 0) continue;
		await rm(path, { force: true }).catch(() => undefined);
	}
}

/**
 * Runs one remote command through the shared one-shot runner and restores the
 * domain outcomes `TargetRuntime` callers depend on: a broad scan and a timeout
 * are `TargetError`s here, not a result flag.
 */
async function runProcess(
	command: string,
	args: readonly string[],
	options: {
		readonly cwd?: string | undefined;
		readonly input?: string | undefined;
		readonly signal?: AbortSignal | undefined;
		readonly timeoutMs?: number | undefined;
		readonly timeoutAsError?: boolean | undefined;
		readonly maxStdoutBytes?: number;
		readonly onData?: ((chunk: Buffer) => void) | undefined;
	},
): Promise<ProcessResult> {
	const result = await runCommand(command, args, {
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.input === undefined ? {} : { input: options.input }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
		...(options.onData === undefined ? {} : { onData: options.onData }),
	}).catch((error: unknown) => {
		if (options.signal?.aborted === true) throw new TargetError("cancelled", "Operation aborted");
		throw error;
	});
	if (result.stdoutTruncated) throw new RemoteScopeTooBroadError();
	if (result.timedOut && options.timeoutAsError !== false)
		throw new TargetError(
			"timeout",
			`Remote operation timed out after ${REMOTE_TIMEOUT_MS / 1000} seconds.`,
		);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
		timedOut: result.timedOut,
	};
}

export class TargetRuntime {
	readonly #notify: Notify;
	readonly #home: string;
	readonly #sshConfigPath: string;
	readonly #allowedHosts = new Set<string>();
	readonly #posixHosts = new Map<string, boolean>();
	#warningShown = false;
	#closed = false;

	private constructor(options: TargetRuntimeOptions, allowedHosts: readonly string[]) {
		this.#notify = options.notify ?? (() => undefined);
		this.#home = options.home ?? homedir();
		this.#sshConfigPath = options.sshConfigPath ?? join(this.#home, ".ssh", "config");
		for (const host of allowedHosts) this.#allowedHosts.add(host);
	}

	static async create(
		options: TargetRuntimeOptions,
		whitelist: readonly string[],
	): Promise<TargetRuntime> {
		const config = await readFile(
			options.sshConfigPath ?? join(options.home ?? homedir(), ".ssh", "config"),
			"utf8",
		).catch(() => "");
		const configured = literalHostAliases(config);
		let warned = configured.has(LOCAL_TARGET);
		const valid: string[] = [];
		for (const host of whitelist) {
			if (
				host === LOCAL_TARGET ||
				host === "." ||
				host === ".." ||
				host.startsWith("-") ||
				host.includes("/") ||
				host.includes("\\") ||
				!configured.has(host) ||
				valid.includes(host)
			) {
				warned = true;
				continue;
			}
			valid.push(host);
		}
		const runtime = new TargetRuntime(options, valid);
		if (warned)
			runtime.warn(
				"Some SSH target settings were ignored because they are reserved, duplicated, or absent from ~/.ssh/config.",
			);
		// Best-effort hygiene: pruning spawns one `ssh -O check` per leftover socket,
		// which must not hold up session start.
		void removeStaleControlSockets(
			join(runtime.#home, ".pi", "agent", "extensions", "pi-ext-tools"),
		);
		return runtime;
	}

	private warn(message: string): void {
		if (this.#warningShown) return;
		this.#warningShown = true;
		this.#notify(message, "warning");
	}

	isRemoteTarget(target: string | undefined): boolean {
		return target !== undefined && target !== LOCAL_TARGET;
	}

	isAllowedHost(target: string): boolean {
		return this.#allowedHosts.has(target);
	}

	prompt(): string {
		const hosts = [...this.#allowedHosts].sort();
		return [
			...TARGET_PROMPT_LINES,
			`Authorized SSH targets: ${hosts.length === 0 ? "none" : hosts.join(", ")}`,
		].join("\n");
	}

	validateRemotePath(path: string): void {
		this.remotePath(path);
	}

	async read(
		target: string | undefined,
		path: string,
		signal?: AbortSignal,
		timeoutMs: number = REMOTE_TIMEOUT_MS,
	): Promise<Buffer> {
		if (target === undefined || target === LOCAL_TARGET)
			return await readFile(posix.isAbsolute(path) ? path : join(process.cwd(), path));
		this.assertHost(target);
		await this.assertPosix(target, signal);
		const remotePath = this.remotePath(path);
		const directory = await this.ensureControlDir();
		const temporary = join(directory, `.read-${randomUUID()}`);
		try {
			const batch = `get ${sftpQuote(remotePath)} ${sftpQuote(temporary)}\n`;
			const result = await this.sftpBatch(target, batch, {
				...(signal === undefined ? {} : { signal }),
				timeoutMs,
			});
			if (result.timedOut)
				throw new TargetError(
					"timeout",
					`Remote SFTP read timed out after ${timeoutMs / 1000} seconds.`,
				);
			if (result.code !== 0) throw new Error(result.stderr.trim() || "Remote SFTP read failed.");
			return await readFile(temporary);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	async sshCapture(
		target: string,
		command: string,
		options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
	): Promise<{
		readonly stdout: string;
		readonly stderr: string;
		readonly code: number;
		readonly timedOut: boolean;
	}> {
		this.assertHost(target);
		await this.assertPosix(target, options.signal);
		const result = await runProcess("ssh", this.sshArgs(target, [`cd "$HOME" && ${command}`]), {
			timeoutAsError: false,
			...(options.signal === undefined ? {} : { signal: options.signal }),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		});
		return {
			stdout: result.stdout.toString("utf8"),
			stderr: result.stderr.toString("utf8"),
			code: result.code,
			timedOut: result.timedOut,
		};
	}

	async sftpBatch(
		target: string,
		batch: string,
		options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
	): Promise<{ readonly stderr: string; readonly code: number; readonly timedOut: boolean }> {
		this.assertHost(target);
		await this.assertPosix(target, options.signal);
		const result = await runProcess("sftp", this.sftpArgs(target), {
			input: batch,
			timeoutAsError: false,
			...(options.signal === undefined ? {} : { signal: options.signal }),
			timeoutMs: options.timeoutMs ?? REMOTE_TIMEOUT_MS,
		});
		return {
			stderr: result.stderr.toString("utf8"),
			code: result.code,
			timedOut: result.timedOut,
		};
	}

	async sftpPut(
		target: string,
		localPath: string,
		remotePath: string,
		options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
	): Promise<{ readonly code: number; readonly timedOut: boolean; readonly stderr: string }> {
		const batch = `put ${sftpQuote(localPath)} ${sftpQuote(this.remotePath(remotePath))}\n`;
		return await this.sftpBatch(target, batch, options);
	}

	async sftpRename(
		target: string,
		from: string,
		to: string,
		replace: boolean,
		options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
	): Promise<{ readonly code: number; readonly timedOut: boolean; readonly stderr: string }> {
		const flag = replace ? "-l " : "";
		const batch = `rename ${flag}${sftpQuote(this.remotePath(from))} ${sftpQuote(this.remotePath(to))}\n`;
		return await this.sftpBatch(target, batch, options);
	}

	async sftpRm(
		target: string,
		remotePath: string,
		options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
	): Promise<{ readonly code: number; readonly timedOut: boolean; readonly stderr: string }> {
		const batch = `rm ${sftpQuote(this.remotePath(remotePath))}\n`;
		return await this.sftpBatch(target, batch, options);
	}

	async exec(
		target: string,
		command: string,
		options: {
			readonly signal?: AbortSignal;
			readonly timeoutMs?: number;
			readonly onData?: (chunk: Buffer) => void;
		} = {},
	): Promise<{ readonly code: number; readonly timedOut: boolean }> {
		this.assertHost(target);
		if (options.signal?.aborted) throw new TargetError("cancelled", "Operation aborted");
		await this.assertPosix(target, options.signal);
		const result = await runProcess("ssh", this.sshArgs(target, [`cd "$HOME" && ${command}`]), {
			timeoutAsError: false,
			...(options.signal === undefined ? {} : { signal: options.signal }),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.onData === undefined ? {} : { onData: options.onData }),
		});
		return { code: result.code, timedOut: result.timedOut };
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
	}

	private assertHost(target: string): void {
		if (!this.#allowedHosts.has(target))
			throw new TargetError("unauthorized", `Unknown or unauthorized SSH target: ${target}`);
	}

	private async assertPosix(target: string, signal?: AbortSignal): Promise<void> {
		const cached = this.#posixHosts.get(target);
		if (cached === true) return;
		if (cached === false)
			throw new TargetError("dependency", `SSH target ${target} is not a POSIX host.`);
		await this.ensureControlDir();
		const result = await runProcess("ssh", this.sshArgs(target, ["uname -s"]), {
			signal,
			timeoutMs: REMOTE_TIMEOUT_MS,
		});
		if (result.code !== 0) {
			throw new Error(
				result.stderr.toString("utf8").trim() || `SSH target ${target} probe failed.`,
			);
		}
		const posix = isPosixUname(result.stdout.toString("utf8"));
		this.#posixHosts.set(target, posix);
		if (!posix) throw new TargetError("dependency", `SSH target ${target} is not a POSIX host.`);
	}

	private remotePath(path: string): string {
		if (path.includes("~") || path.split("/").some((part) => part === ".."))
			throw new Error("Remote paths cannot contain '~' or '..'.");
		if (path === "") return ".";
		return path;
	}

	private controlDir(): string {
		return join(this.#home, ".pi", "agent", "extensions", "pi-ext-tools", "targets");
	}

	private controlPath(target: string): string {
		return join(this.controlDir(), `${target}.sock`);
	}

	private async ensureControlDir(): Promise<string> {
		const directory = this.controlDir();
		await mkdir(directory, { recursive: true });
		return directory;
	}

	private sshArgs(target: string, tail: readonly string[]): string[] {
		return [...this.connectionOptions(target), target, ...tail];
	}

	private sftpArgs(target: string): string[] {
		return [...this.connectionOptions(target), "-b", "-", target];
	}

	private connectionOptions(target: string): string[] {
		const path = this.controlPath(target);
		return [
			"-o",
			"BatchMode=yes",
			"-o",
			`ConnectTimeout=${REMOTE_TIMEOUT_MS / 1000}`,
			"-o",
			"ControlMaster=auto",
			"-o",
			`ControlPersist=${CONTROL_PERSIST}`,
			"-o",
			`ControlPath=${path}`,
		];
	}
}

export function applyTargetPromptSection(
	sections: Record<string, string>,
	runtime: TargetRuntime | undefined,
): void {
	setPromptSection(sections, TARGET_PROMPT_SECTION, runtime?.prompt());
}
