import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readProcessOutputTail } from "./stream-output.js";

export type SessionStatus = "connected" | "reconnecting";

export interface Session {
	host: string;
	socketPath: string;
	lastUsed: number;
	status: SessionStatus;
}

export interface ProcessResult {
	exitCode: number | null;
	output?: string;
	stdout: string;
	stderr: string;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
	truncated?: boolean;
	totalBytes?: number;
	outputBytes?: number;
	totalLines?: number;
	outputLines?: number;
	notice?: string;
}

export type ProcessRunner = (args: string[], timeoutMs?: number) => Promise<ProcessResult>;

export interface MountProbeResult {
	mounted: boolean;
	healthy: boolean;
}

export type MountProbe = (mountPath: string) => Promise<MountProbeResult>;
export type MountUnmounter = (mountPath: string) => Promise<boolean>;
export type SshMountStatus = "mounted" | "reused" | "remounted";

export interface SshMountResult {
	host: string;
	localPath: string;
	status: SshMountStatus;
}

export interface SessionManagerOptions {
	sshBin?: string;
	sshfsBin?: string;
	controlDir?: string;
	mountDir?: string;
	platform?: NodeJS.Platform;
	controlPersist?: string;
	supportsControlMaster?: boolean;
	connectTimeoutSeconds?: number;
	connectionAttempts?: number;
	serverAliveIntervalSeconds?: number;
	serverAliveCountMax?: number;
	failureBackoffMs?: number;
	mountProbe?: MountProbe;
	unmountMount?: MountUnmounter;
}

interface HostFailureState {
	failures: number;
	blockedUntil: number;
}

interface MountState {
	host: string;
	mountPath: string;
	lastUsed: number;
}

const DEFAULT_PLUGIN_DIR = join(homedir(), ".codex", "ssh-exec");
const DEFAULT_CONTROL_DIR = DEFAULT_PLUGIN_DIR;
const DEFAULT_MOUNT_DIR = join(homedir(), ".cache", "ssh-exec");
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 30;
const DEFAULT_MASTER_SETUP_TIMEOUT_MS = 30_000;
const DEFAULT_SERVER_ALIVE_INTERVAL_SECONDS = 300;
const DEFAULT_SERVER_ALIVE_COUNT_MAX = 3;
const CONTROL_CHECK_TIMEOUT_MS = 10_000;

export class SessionManager {
	readonly sshBin: string;
	readonly sshfsBin: string;
	readonly controlDir: string;
	readonly mountDir: string;
	readonly platform: NodeJS.Platform;
	readonly controlPersist: string;
	readonly supportsControlMaster: boolean;
	readonly connectTimeoutSeconds: number;
	readonly connectionAttempts: number;
	readonly serverAliveIntervalSeconds: number;
	readonly serverAliveCountMax: number;
	readonly failureBackoffMs: number;

	readonly #sessions = new Map<string, Session>();
	readonly #pending = new Map<string, Promise<Session>>();
	readonly #failures = new Map<string, HostFailureState>();
	readonly #mounts = new Map<string, MountState>();
	readonly #mountProbe: MountProbe;
	readonly #unmountMount: MountUnmounter;

	constructor(options: SessionManagerOptions = {}) {
		this.sshBin = options.sshBin ?? process.env.SSH_EXEC_SSH_BIN ?? "ssh";
		this.sshfsBin = options.sshfsBin ?? process.env.SSH_EXEC_SSHFS_BIN ?? "sshfs";
		this.controlDir = options.controlDir ?? process.env.SSH_EXEC_CONTROL_DIR ?? DEFAULT_CONTROL_DIR;
		this.mountDir = options.mountDir ?? process.env.SSH_EXEC_MOUNT_DIR ?? DEFAULT_MOUNT_DIR;
		this.platform = options.platform ?? process.platform;
		this.controlPersist =
			options.controlPersist ??
			envString("SSH_EXEC_CONTROL_PERSIST_SECONDS", envString("SSH_EXEC_CONTROL_PERSIST", "3600"));
		this.supportsControlMaster = options.supportsControlMaster ?? this.platform !== "win32";
		this.connectTimeoutSeconds = clampPositiveInt(
			options.connectTimeoutSeconds ?? envNumber("SSH_EXEC_CONNECT_TIMEOUT_SECONDS"),
			DEFAULT_CONNECT_TIMEOUT_SECONDS,
		);
		this.connectionAttempts = clampPositiveInt(
			options.connectionAttempts ?? envNumber("SSH_EXEC_CONNECTION_ATTEMPTS"),
			2,
		);
		this.serverAliveIntervalSeconds = clampPositiveInt(
			options.serverAliveIntervalSeconds ?? envNumber("SSH_EXEC_SERVER_ALIVE_INTERVAL_SECONDS"),
			DEFAULT_SERVER_ALIVE_INTERVAL_SECONDS,
		);
		this.serverAliveCountMax = clampPositiveInt(
			options.serverAliveCountMax ?? envNumber("SSH_EXEC_SERVER_ALIVE_COUNT_MAX"),
			DEFAULT_SERVER_ALIVE_COUNT_MAX,
		);
		this.failureBackoffMs = Math.max(
			0,
			options.failureBackoffMs ?? envNumber("SSH_EXEC_FAILURE_BACKOFF_MS") ?? 15_000,
		);
		this.#mountProbe =
			options.mountProbe ?? (async (mountPath) => await this.probeMount(mountPath));
		this.#unmountMount =
			options.unmountMount ?? (async (mountPath) => await this.unmountPath(mountPath));
	}

	get(host: string): Session {
		const existing = this.#sessions.get(host);
		if (existing) return existing;

		const session: Session = {
			host,
			socketPath: join(this.controlDir, `${sanitizeHostForSocket(host)}.sock`),
			lastUsed: 0,
			status: "reconnecting",
		};
		this.#sessions.set(host, session);
		return session;
	}

	getMountPath(host: string): string {
		return join(this.mountDir, sanitizeHostForSocket(host));
	}

	async ensureConnected(host: string, runner: ProcessRunner): Promise<Session> {
		this.assertHostAvailable(host);
		const pending = this.#pending.get(host);
		if (pending) return await pending;

		const promise = this.connect(host, runner);
		this.#pending.set(host, promise);
		try {
			return await promise;
		} finally {
			this.#pending.delete(host);
		}
	}

	async ensureMounted(host: string, runner: ProcessRunner): Promise<SshMountResult> {
		this.assertMountPlatformSupported();
		await this.ensureConnected(host, runner);
		await this.ensureMountDir();

		const mountPath = this.getMountPath(host);
		await mkdir(mountPath, { recursive: true, mode: 0o700 });
		await chmod(mountPath, 0o700).catch(() => {});

		const current = await this.#mountProbe(mountPath);
		if (current.mounted && current.healthy) {
			this.#mounts.set(host, { host, mountPath, lastUsed: Date.now() });
			return { host, localPath: mountPath, status: "reused" };
		}

		let status: SshMountStatus = "mounted";
		if (current.mounted || (await this.directoryHasEntries(mountPath))) {
			await this.#unmountMount(mountPath).catch(() => false);
			status = "remounted";
		}

		const session = this.get(host);
		const result = await this.runBinary(
			this.sshfsBin,
			this.buildSshfsArgs(session, mountPath),
			20_000,
			{
				tolerateMissingBinary: true,
			},
		);
		if (result.exitCode === 127) {
			throw new Error("sshfs binary not found");
		}
		if (result.exitCode !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim();
			const suffix = detail ? `: ${this.sanitize(detail)}` : "";
			throw new Error(`Failed mount ${host} ${mountPath}${suffix}`);
		}

		const mounted = await this.#mountProbe(mountPath);
		if (!mounted.mounted || !mounted.healthy) {
			throw new Error(
				`Mounted ${host} ${mountPath}, but mount probe did not report healthy sshfs mount`,
			);
		}

		this.#mounts.set(host, { host, mountPath, lastUsed: Date.now() });
		return { host, localPath: mountPath, status };
	}

	async closeAll(runner: ProcessRunner, timeoutMs = 5_000): Promise<void> {
		const mounts = Array.from(this.#mounts.values());
		await Promise.allSettled(
			mounts.map(async (mount) => {
				try {
					await this.#unmountMount(mount.mountPath);
				} catch {
					// Cleanup is best-effort.
				} finally {
					this.#mounts.delete(mount.host);
				}
			}),
		);

		const sessions = Array.from(this.#sessions.values());
		await Promise.allSettled(
			sessions.map(async (session) => {
				try {
					await runner(this.buildControlArgs(session, "exit"), timeoutMs);
				} catch {
					// Cleanup is best-effort. Callers should not block on failed exits.
				} finally {
					this.#sessions.delete(session.host);
					await this.removeSocketIfPresent(session.socketPath);
				}
			}),
		);
	}

	buildRunArgs(session: Session, command: string): string[] {
		return [...this.buildCommonArgs(session), session.host, command];
	}

	sensitiveValues(host?: string): string[] {
		const values = Array.from(this.#sessions.values(), (session) => session.socketPath);
		if (host) values.push(this.get(host).socketPath);
		values.push(this.controlDir);
		return values;
	}

	sanitize(value: string): string {
		let sanitized = value;
		for (const session of this.#sessions.values()) {
			sanitized = sanitized.split(session.socketPath).join("<control-socket>");
		}
		sanitized = sanitized.split(this.controlDir).join("<control-socket-dir>");
		return sanitized;
	}

	buildControlArgs(session: Session, operation: "check" | "exit"): string[] {
		return ["-O", operation, ...this.buildCommonArgs(session), session.host];
	}

	buildStartArgs(session: Session): string[] {
		return ["-M", "-N", "-f", ...this.buildCommonArgs(session), session.host];
	}

	buildCommonArgs(session?: Session): string[] {
		const args = [
			"-n",
			"-o",
			`ConnectTimeout=${this.connectTimeoutSeconds}`,
			"-o",
			`ConnectionAttempts=${this.connectionAttempts}`,
			"-o",
			`ServerAliveInterval=${this.serverAliveIntervalSeconds}`,
			"-o",
			`ServerAliveCountMax=${this.serverAliveCountMax}`,
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
		];
		if (this.supportsControlMaster && session) {
			args.push(
				"-S",
				session.socketPath,
				"-o",
				"ControlMaster=auto",
				"-o",
				`ControlPersist=${this.controlPersist}`,
			);
		}
		return args;
	}

	buildSshfsArgs(session: Session, mountPath: string): string[] {
		const args = [
			"-o",
			"reconnect",
			"-o",
			`ServerAliveInterval=${this.serverAliveIntervalSeconds}`,
			"-o",
			`ServerAliveCountMax=${this.serverAliveCountMax}`,
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
		];
		if (this.supportsControlMaster) {
			args.push(
				"-o",
				"ControlMaster=auto",
				"-o",
				`ControlPath=${session.socketPath}`,
				"-o",
				`ControlPersist=${this.controlPersist}`,
			);
		}
		args.push(`${session.host}:/`, mountPath);
		return args;
	}

	private async connect(host: string, runner: ProcessRunner): Promise<Session> {
		const session = this.get(host);
		session.status = "reconnecting";

		if (!this.supportsControlMaster) {
			session.status = "connected";
			session.lastUsed = Date.now();
			this.markHostSuccess(host);
			return session;
		}

		await this.ensureControlDir();
		await this.removeStaleSocket(session.socketPath);
		const startedAt = Date.now();

		try {
			const check = await runner(this.buildControlArgs(session, "check"), CONTROL_CHECK_TIMEOUT_MS);
			if (check.exitCode !== 0) {
				await this.removeSocketIfPresent(session.socketPath);
				const remainingSetupMs = Math.max(
					1,
					DEFAULT_MASTER_SETUP_TIMEOUT_MS - (Date.now() - startedAt),
				);
				const start = await runner(this.buildStartArgs(session), remainingSetupMs);
				if (start.exitCode !== 0) {
					const detail = start.stderr.trim() || start.stdout.trim();
					const suffix = detail ? `: ${this.sanitize(detail)}` : "";
					throw new Error(`Failed to start SSH master for ${host}${suffix}`);
				}
			}

			session.status = "connected";
			session.lastUsed = Date.now();
			this.markHostSuccess(host);
			return session;
		} catch (error) {
			session.status = "reconnecting";
			this.markHostFailure(host);
			throw error;
		}
	}

	private assertHostAvailable(host: string): void {
		const failure = this.#failures.get(host);
		if (!failure) return;
		if (failure.blockedUntil === 0) return;
		if (failure.blockedUntil <= Date.now()) {
			this.#failures.delete(host);
			return;
		}
		throw new Error(`SSH host ${host} is temporarily blocked after repeated connection failures`);
	}

	private markHostSuccess(host: string): void {
		this.#failures.delete(host);
	}

	private markHostFailure(host: string): void {
		const current = this.#failures.get(host);
		const failures = (current?.failures ?? 0) + 1;
		this.#failures.set(host, {
			failures,
			blockedUntil: failures > 1 ? Date.now() + this.failureBackoffMs : 0,
		});
	}

	private async ensureControlDir(): Promise<void> {
		await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
		await chmod(this.controlDir, 0o700).catch(() => {});
	}

	private async ensureMountDir(): Promise<void> {
		await mkdir(this.mountDir, { recursive: true, mode: 0o700 });
		await chmod(this.mountDir, 0o700).catch(() => {});
	}

	private async removeStaleSocket(socketPath: string): Promise<void> {
		await rm(socketPath, { force: true }).catch(() => {});
	}

	private async removeSocketIfPresent(socketPath: string): Promise<void> {
		await rm(socketPath, { force: true }).catch(() => {});
	}

	private async directoryHasEntries(path: string): Promise<boolean> {
		try {
			return (await readdir(path)).length > 0;
		} catch {
			return false;
		}
	}

	private async probeMount(mountPath: string): Promise<MountProbeResult> {
		try {
			const stats = await stat(mountPath);
			if (!stats.isDirectory()) return { mounted: false, healthy: false };
		} catch {
			return { mounted: false, healthy: false };
		}

		const result = await this.runBinary("mount", [], 5_000, { tolerateMissingBinary: true });
		if (result.exitCode !== 0) return { mounted: false, healthy: false };
		const output = result.stdout || result.output || "";
		const mounted = output.split("\n").some((line) => line.includes(` on ${mountPath} `));
		return { mounted, healthy: mounted };
	}

	private async unmountPath(mountPath: string): Promise<boolean> {
		const strategies: [string, ...string[]][] =
			this.platform === "linux"
				? [
						["fusermount", "-u", mountPath],
						["umount", mountPath],
					]
				: [
						["umount", mountPath],
						["diskutil", "unmount", mountPath],
					];

		for (const [bin, ...rest] of strategies) {
			const result = await this.runBinary(bin, rest, 10_000, { tolerateMissingBinary: true });
			if (result.exitCode === 0) return true;
		}
		return false;
	}

	private async runBinary(
		bin: string,
		args: string[],
		timeoutMs: number,
		options: { tolerateMissingBinary?: boolean } = {},
	): Promise<ProcessResult> {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			if (options.tolerateMissingBinary && isMissingBinaryError(error)) {
				return { exitCode: 127, stdout: "", stderr: "" };
			}
			throw error;
		}

		let timedOut = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
		}, timeoutMs);

		try {
			const [output, exitCode] = await Promise.all([
				readProcessOutputTail(child.stdout, child.stderr, this.sensitiveValues()),
				new Promise<number | null>((resolve, reject) => {
					child.once("error", (error) => {
						if (options.tolerateMissingBinary && isMissingBinaryError(error)) {
							resolve(127);
							return;
						}
						reject(error);
					});
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
				...(timedOut ? { notice: `${bin} timed out after ${Math.round(timeoutMs / 1000)}s` } : {}),
			};
		} catch (error) {
			if (
				options.tolerateMissingBinary &&
				error instanceof Error &&
				(error.message.includes("Premature close") || isMissingBinaryError(error))
			) {
				return { exitCode: 127, stdout: "", stderr: "" };
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
		}
	}

	private assertMountPlatformSupported(): void {
		if (this.platform === "linux" || this.platform === "darwin") return;
		throw new Error(
			`ssh_mount is currently supported only on Linux and macOS hosts running Codex locally; current platform is ${this.platform}`,
		);
	}
}

export function sanitizeHostForSocket(host: string): string {
	return host.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
function envString(name: string, fallback: string): string {
	const value = process.env[name];
	return value?.trim() ? value.trim() : fallback;
}

function envNumber(name: string): number | undefined {
	const value = process.env[name];
	if (!value?.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

function isMissingBinaryError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: string }).code === "ENOENT",
	);
}
