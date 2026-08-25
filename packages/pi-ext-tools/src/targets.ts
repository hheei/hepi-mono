import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { OutputRegistry, OutputUri } from "@hheei/pi-ext-core";

export const LOCAL_TARGET = "local";
export const OUTPUT_TARGET = "output";
export const REMOTE_TIMEOUT_MS = 20_000;
export const CONTROL_PERSIST = "15m";
export const MAX_REMOTE_FIND_PATHS = 1_024;
export const MAX_REMOTE_FIND_BYTES = 256 * 1024;
const OUTPUT_SIDECAR_SUFFIX = ".pi-ext-tools-output.jsonl";
const MAX_OUTPUTS = 128;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES_EACH = 1024 * 1024;
const TARGET_PROMPT_MARKER = "<pi-ext-tools-targets>";
const TARGET_PROMPT_LINES = [
	"read, grep, find, edit, and write accept target: local, output, or an authorized SSH host. bash and apply_patch accept local or an authorized SSH host.",
	"Omitting target uses local. Remote targets are POSIX hosts. read/grep/find use a 20 second timeout and do not use FFF; bash has no default timeout and does not support pty, async, or output. apply_patch, remote edit, and remote write files are capped at 32 MiB.",
	"target: output reads persisted output ids; find, edit, write, bash, and apply_patch do not support output.",
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

type OutputRecord = {
	readonly id: string;
	readonly text: string;
};

type SessionManagerLike = {
	readonly getSessionId?: () => string;
	readonly getSessionFile?: () => string | undefined;
};

type TargetRuntimeOptions = {
	readonly outputs: OutputRegistry;
	readonly sessionManager?: SessionManagerLike;
	readonly notify?: Notify;
	readonly home?: string;
	readonly sshConfigPath?: string;
};

export type TargetOutput = {
	readonly id: string;
	readonly uri: OutputUri;
	readonly persistent: boolean;
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
	throw new TargetError("unauthorized", `${tool} does not support remote or output targets.`);
}

export function remoteShellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isGlob(value: string): boolean {
	return /[*?[{]/u.test(value);
}

function splitWords(value: string): readonly string[] {
	return value.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

function fuzzyScore(value: string, query: string): number | undefined {
	const lower = value.toLocaleLowerCase();
	let score = 0;
	for (const word of splitWords(query)) {
		let cursor = 0;
		let previous = -1;
		for (const character of word) {
			const index = lower.indexOf(character, cursor);
			if (index < 0) return undefined;
			if (index === previous + 1) score += 2;
			score += Math.max(1, 20 - index);
			previous = index;
			cursor = index + 1;
		}
	}
	return score;
}

function globRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu");
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

function sessionPath(sessionManager: SessionManagerLike | undefined): string | undefined {
	try {
		return sessionManager?.getSessionFile?.();
	} catch {
		return undefined;
	}
}

function parentSessionFile(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const parent = Reflect.get(value, "parentSession");
	return typeof parent === "string" && parent !== "" ? parent : undefined;
}

function outputRecord(value: unknown): OutputRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const id = Reflect.get(value, "id");
	const text = Reflect.get(value, "text");
	if (typeof id !== "string" || typeof text !== "string") return undefined;
	return { id, text };
}

function missingRemoteCommand(result: ProcessResult, command: string): boolean {
	if (result.code === 127) return true;
	const stderr = result.stderr.toString("utf8");
	return new RegExp(
		`(?:command not found|not found):?\\s+${command}\\b|${command}:\\s+not found`,
		"iu",
	).test(stderr);
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

function sessionId(sessionManager: SessionManagerLike | undefined): string {
	try {
		const value = sessionManager?.getSessionId?.();
		if (value !== undefined && value !== "") return value;
	} catch {
		// Fall through to a process-local identity for hosts without sessions.
	}
	return "process";
}

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
	return await new Promise<ProcessResult>((resolveResult, reject) => {
		const child = spawn(command, args, {
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let timedOut = false;
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			callback();
		};
		const abort = (): void => {
			child.kill();
			finish(() => reject(new TargetError("cancelled", "Operation aborted")));
		};
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeoutMs);
		options.signal?.addEventListener("abort", abort, { once: true });
		const push = (chunk: Buffer, stream: Buffer[]): void => {
			stream.push(chunk);
			options.onData?.(chunk);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
				child.kill();
				finish(() => reject(new RemoteScopeTooBroadError()));
				return;
			}
			push(chunk, stdout);
		});
		child.stderr?.on("data", (chunk: Buffer) => push(chunk, stderr));
		child.once("error", (error) => finish(() => reject(error)));
		child.once("close", (code) => {
			finish(() => {
				if (timedOut && options.timeoutAsError !== false)
					return reject(
						new TargetError(
							"timeout",
							`Remote operation timed out after ${REMOTE_TIMEOUT_MS / 1000} seconds.`,
						),
					);
				resolveResult({
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr),
					code: code ?? 1,
					timedOut,
				});
			});
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

export class TargetRuntime {
	readonly #outputs: OutputRegistry;
	readonly #notify: Notify;
	readonly #home: string;
	readonly #sshConfigPath: string;
	readonly #sessionId: string;
	readonly #sessionFile: string | undefined;
	readonly #sidecarPath: string | undefined;
	readonly #outputUris = new Map<string, OutputUri>();
	readonly #allowedHosts = new Set<string>();
	readonly #posixHosts = new Map<string, boolean>();
	#persistedCount = 0;
	#persistedBytes = 0;
	#warningShown = false;
	#persistWarningShown = false;
	#closed = false;

	private constructor(options: TargetRuntimeOptions, allowedHosts: readonly string[]) {
		this.#outputs = options.outputs;
		this.#notify = options.notify ?? (() => undefined);
		this.#home = options.home ?? homedir();
		this.#sshConfigPath = options.sshConfigPath ?? join(this.#home, ".ssh", "config");
		this.#sessionId = sessionId(options.sessionManager);
		this.#sessionFile = sessionPath(options.sessionManager);
		this.#sidecarPath =
			this.#sessionFile === undefined ? undefined : `${this.#sessionFile}${OUTPUT_SIDECAR_SUFFIX}`;
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
		let warned = configured.has(LOCAL_TARGET) || configured.has(OUTPUT_TARGET);
		const valid: string[] = [];
		for (const host of whitelist) {
			if (
				host === LOCAL_TARGET ||
				host === OUTPUT_TARGET ||
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
		await removeStaleControlSockets(
			join(runtime.#home, ".pi", "agent", "extensions", "pi-ext-tools"),
		);
		await runtime.loadSidecars();
		return runtime;
	}

	private warn(message: string): void {
		if (this.#warningShown) return;
		this.#warningShown = true;
		this.#notify(message, "warning");
	}

	private warnNonPersistent(): void {
		if (this.#persistWarningShown) return;
		this.#persistWarningShown = true;
		this.#notify("Unable to persist output; it remains available only in this session.", "warning");
	}

	isRemoteTarget(target: string | undefined): boolean {
		return target !== undefined && target !== LOCAL_TARGET && target !== OUTPUT_TARGET;
	}

	isAllowedHost(target: string): boolean {
		return this.#allowedHosts.has(target);
	}

	prompt(): string {
		const hosts = [...this.#allowedHosts].sort();
		return [
			TARGET_PROMPT_MARKER,
			...TARGET_PROMPT_LINES,
			`Authorized SSH targets: ${hosts.length === 0 ? "none" : hosts.join(", ")}`,
			"</pi-ext-tools-targets>",
		].join("\n");
	}

	createOutput(text: string): TargetOutput {
		const uri = this.#outputs.create(text);
		const id = `${this.#sessionId}:${randomUUID()}`;
		this.#outputUris.set(id, uri);
		const bytes = Buffer.byteLength(text, "utf8");
		const sidecar = this.#sidecarPath;
		if (sidecar === undefined) return { id, uri, persistent: false };
		const canPersist =
			bytes <= MAX_OUTPUT_BYTES_EACH &&
			this.#persistedCount < MAX_OUTPUTS &&
			this.#persistedBytes + bytes <= MAX_OUTPUT_BYTES;
		if (!canPersist) {
			this.warnNonPersistent();
			return { id, uri, persistent: false };
		}
		const record = `${JSON.stringify({ id, text } satisfies OutputRecord)}\n`;
		try {
			appendFileSync(sidecar, record, "utf8");
		} catch {
			this.warnNonPersistent();
			return { id, uri, persistent: false };
		}
		this.#persistedCount += 1;
		this.#persistedBytes += bytes;
		return { id, uri, persistent: true };
	}

	readOutput(
		id: string,
		options: { readonly offset?: number; readonly limit?: number } = {},
	): string {
		const uri = this.#outputUris.get(id);
		if (uri === undefined) throw new Error("Unknown output target or unavailable output session.");
		return this.#outputs.read(uri, options);
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
		if (target === OUTPUT_TARGET) return Buffer.from(this.readOutput(path), "utf8");
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

	async grep(
		target: string,
		command: string,
		signal?: AbortSignal,
		maxStdoutBytes?: number,
	): Promise<string> {
		this.assertHost(target);
		await this.assertPosix(target, signal);
		const result = await runProcess("ssh", this.sshArgs(target, [`cd "$HOME" && ${command}`]), {
			signal,
			timeoutMs: REMOTE_TIMEOUT_MS,
			...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
		});
		if (missingRemoteCommand(result, "rg"))
			throw new TargetError("dependency", "Remote host is missing rg.");
		const stdout = result.stdout.toString("utf8");
		if (result.code !== 0 && result.code !== 1) {
			const stderr = result.stderr.toString("utf8");
			const diagnostics = result.code === 2 ? accessDeniedDiagnostics(stderr) : undefined;
			if (diagnostics !== undefined) throw new RemoteGrepAccessDeniedError(stdout, diagnostics);
			throw new Error(stderr.trim() || "Remote search failed.");
		}
		return stdout;
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

	async find(
		target: string,
		path: string | undefined,
		pattern: string,
		signal?: AbortSignal,
	): Promise<readonly RemoteFindCandidate[]> {
		const remotePath = isGlob(path ?? "") ? "." : this.remotePath(path ?? ".");
		const pathMatcher = isGlob(path ?? "") ? globRegex(path ?? "") : undefined;
		const output = await this.grep(
			target,
			`rg --files --hidden --color=never -- ${remoteShellQuote(remotePath)}`,
			signal,
			MAX_REMOTE_FIND_BYTES + 1,
		);
		const paths = output.split(/\r?\n/u).filter(Boolean);
		if (
			paths.length > MAX_REMOTE_FIND_PATHS ||
			Buffer.byteLength(output, "utf8") > MAX_REMOTE_FIND_BYTES
		)
			throw new RemoteScopeTooBroadError();
		const matcher = isGlob(pattern) ? globRegex(pattern) : undefined;
		const candidates: RemoteFindCandidate[] = [];
		for (const candidate of paths) {
			const relative = candidate.startsWith("./") ? candidate.slice(2) : candidate;
			if (pathMatcher !== undefined && !pathMatcher.test(relative)) continue;
			if (matcher !== undefined) {
				if (matcher.test(relative))
					candidates.push({ path: relative, matchType: "path", score: 1 });
				continue;
			}
			const score = fuzzyScore(relative, pattern);
			if (score !== undefined) candidates.push({ path: relative, matchType: "fuzzy", score });
		}
		return candidates.sort(
			(left, right) => right.score - left.score || left.path.localeCompare(right.path),
		);
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

	private async loadSidecars(): Promise<void> {
		if (this.#sidecarPath === undefined) return;
		const files: string[] = [];
		let current: string | undefined = this.#sessionFile;
		const seen = new Set<string>();
		while (current !== undefined && !seen.has(current)) {
			seen.add(current);
			files.push(`${current}${OUTPUT_SIDECAR_SUFFIX}`);
			const header = await readFile(current, "utf8").catch(() => "");
			const first = header.split(/\r?\n/u)[0];
			try {
				current = parentSessionFile(first === undefined ? undefined : JSON.parse(first));
			} catch {
				current = undefined;
			}
		}
		for (const file of files.reverse()) await this.loadSidecar(file);
	}

	private async loadSidecar(path: string): Promise<void> {
		const text = await readFile(path, "utf8").catch(() => "");
		if (text === "") return;
		let invalid = false;
		for (const line of text.split(/\r?\n/u)) {
			if (line.trim() === "") continue;
			try {
				const record = outputRecord(JSON.parse(line));
				if (record === undefined || this.#outputUris.has(record.id))
					throw new Error("invalid or duplicate output record");
				const bytes = Buffer.byteLength(record.text, "utf8");
				if (
					bytes > MAX_OUTPUT_BYTES_EACH ||
					this.#persistedCount >= MAX_OUTPUTS ||
					this.#persistedBytes + bytes > MAX_OUTPUT_BYTES
				)
					continue;
				this.#outputUris.set(record.id, this.#outputs.create(record.text));
				this.#persistedCount += 1;
				this.#persistedBytes += bytes;
			} catch {
				invalid = true;
			}
		}
		if (invalid) this.#notify(`Ignored invalid pi-ext-tools output records in ${path}.`, "warning");
	}
}

export function targetPromptBlock(runtime: TargetRuntime | undefined): string | undefined {
	return runtime?.prompt();
}

export function stripTargetPrompt(systemPrompt: string): string {
	const start = systemPrompt.indexOf(TARGET_PROMPT_MARKER);
	if (start < 0) return systemPrompt;
	const end = systemPrompt.indexOf("</pi-ext-tools-targets>", start);
	return end < 0
		? systemPrompt
		: systemPrompt.slice(0, start).trimEnd() +
				systemPrompt.slice(end + "</pi-ext-tools-targets>".length);
}
