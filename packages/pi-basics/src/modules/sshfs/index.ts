import { chmod, lstat, mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const SSHFS_TOOL_NAME = "sshfs";
export const SSHFS_PARAMETERS = Type.Object(
	{
		host: Type.String({ minLength: 1, description: "OpenSSH host alias or destination" }),
	},
	{ additionalProperties: false },
);

const SSHFS_TIMEOUT_MS = 30_000;
const MOUNT_OPERATION_TIMEOUT_MS = 24_000;
const ROLLBACK_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_RETRY_MS = 100;
const SSHFS_MOUNT_TYPE =
	/(?:^|[\s,(])(?:fuse\.)?sshfs(?:[\s,)]|$)|(?:^|[\s,(])(?:mac|osx)fuse(?:[\s,)]|$)/i;

export interface SshfsToolDetails {
	readonly host: string;
	readonly localPath: string;
	readonly status: "mounted" | "reused";
}

export interface SshfsFeature {
	dispose(): Promise<void>;
}

export interface SshfsFeatureOptions {
	readonly mountRoot?: string;
	readonly platform?: NodeJS.Platform;
}

type MountProbe =
	| { readonly state: "unmounted" }
	| { readonly state: "matching"; readonly healthy: boolean }
	| { readonly state: "conflict"; readonly source: string };

interface MountEntry {
	readonly source: string;
	readonly metadata: string;
}

export function validateSshfsHost(value: string): string {
	const host = value.trim();
	if (host === "") throw new Error("sshfs.host must be a non-empty string");
	if (host.startsWith("-")) throw new Error("sshfs.host must not start with '-'");
	if (/[\0\r\n\t ]/.test(host)) throw new Error("sshfs.host must not contain whitespace");
	return host;
}

export function createSshfsFeature(
	pi: ExtensionAPI,
	options: SshfsFeatureOptions = {},
): SshfsFeature {
	const mountRoot = options.mountRoot ?? join(homedir(), ".cache", "sshfs-addon");
	const platform = options.platform ?? process.platform;
	const ownedMounts = new Map<string, string>();

	const probeMount = async (
		localPath: string,
		expectedSource: string,
		signal?: AbortSignal,
	): Promise<MountProbe> => {
		signal?.throwIfAborted();
		const result = await pi.exec("mount", [], {
			timeout: PROBE_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		});
		if (result.killed) {
			signal?.throwIfAborted();
			throw new Error("sshfs mount probe timed out");
		}
		if (result.code !== 0) throw new Error(`Unable to inspect mounts: mount exited ${result.code}`);
		const entry = findMountEntry(result.stdout, localPath);
		if (!entry) return { state: "unmounted" };
		const actualSource = await probeFilesystemSource(pi, localPath, signal);
		if (actualSource !== entry.source) return { state: "unmounted" };
		if (entry.source !== expectedSource || !SSHFS_MOUNT_TYPE.test(entry.metadata)) {
			return { state: "conflict", source: entry.source };
		}
		try {
			await readdir(localPath);
			signal?.throwIfAborted();
			return { state: "matching", healthy: true };
		} catch (error) {
			signal?.throwIfAborted();
			if (isAbortError(error)) throw error;
			return { state: "matching", healthy: false };
		}
	};

	const waitForHealthyMount = async (
		localPath: string,
		source: string,
		signal?: AbortSignal,
	): Promise<MountProbe> => {
		const deadline = Date.now() + HEALTH_TIMEOUT_MS;
		let lastProbe: MountProbe = { state: "unmounted" };
		let lastError: unknown;
		for (;;) {
			try {
				lastProbe = await probeMount(localPath, source, signal);
				lastError = undefined;
				if (lastProbe.state === "matching" && lastProbe.healthy) return lastProbe;
			} catch (error) {
				signal?.throwIfAborted();
				lastError = error;
			}
			if (Date.now() >= deadline) break;
			await delay(HEALTH_RETRY_MS, undefined, signal ? { signal } : undefined);
		}
		if (lastError !== undefined) throw lastError;
		return lastProbe;
	};

	const unmount = async (
		localPath: string,
		source: string,
		signal?: AbortSignal,
	): Promise<MountProbe | undefined> => {
		const strategies: ReadonlyArray<readonly [string, ...string[]]> =
			platform === "linux"
				? [
						["fusermount", "-u", localPath],
						["umount", localPath],
					]
				: [
						["umount", localPath],
						["diskutil", "unmount", localPath],
					];
		for (const [command, ...args] of strategies) {
			signal?.throwIfAborted();
			try {
				const result = await pi.exec(command, args, {
					timeout: SSHFS_TIMEOUT_MS,
					...(signal ? { signal } : {}),
				});
				if (result.killed) {
					signal?.throwIfAborted();
					continue;
				}
				if (result.code === 0) {
					const current = await probeMount(localPath, source, signal);
					if (current.state !== "matching") return current;
				}
			} catch (error) {
				signal?.throwIfAborted();
				if (isAbortError(error)) throw error;
				// Try the next platform-supported unmount command.
			}
		}
		const current = await probeMount(localPath, source, signal);
		return current.state === "matching" ? undefined : current;
	};

	const cleanupOwnedMount = async (
		localPath: string,
		source: string,
		signal?: AbortSignal,
	): Promise<void> => {
		const current = await probeMount(localPath, source, signal);
		if (current.state === "conflict") {
			ownedMounts.delete(localPath);
			return;
		}
		if (current.state === "unmounted") {
			ownedMounts.delete(localPath);
			await rmdir(localPath).catch(() => undefined);
			return;
		}
		const afterUnmount = await unmount(localPath, source, signal);
		if (!afterUnmount) throw new Error(`Unable to unmount sshfs mount: ${localPath}`);
		ownedMounts.delete(localPath);
		if (afterUnmount.state === "unmounted") await rmdir(localPath).catch(() => undefined);
	};

	const rollbackMount = async (localPath: string, source: string): Promise<void> => {
		const rollbackSignal = AbortSignal.timeout(ROLLBACK_TIMEOUT_MS);
		try {
			const current = await probeMount(localPath, source, rollbackSignal);
			if (current.state === "matching") {
				await cleanupOwnedMount(localPath, source, rollbackSignal);
				return;
			}
			ownedMounts.delete(localPath);
			if (current.state === "unmounted") await rmdir(localPath).catch(() => undefined);
		} catch {
			// Keep possible ownership so session cleanup can retry.
		}
	};

	const mount = async (
		hostValue: string,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<SshfsToolDetails>> => {
		const deadlineSignal = AbortSignal.timeout(MOUNT_OPERATION_TIMEOUT_MS);
		const operationSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
		operationSignal.throwIfAborted();
		if (platform !== "linux" && platform !== "darwin") {
			throw new Error(
				`sshfs is supported only on Linux and macOS; current platform is ${platform}`,
			);
		}
		const host = validateSshfsHost(hostValue);
		const source = `${host}:/`;
		const segment = encodeURIComponent(host);
		const localPath = join(
			mountRoot,
			segment === "." || segment === ".." ? `_${segment}` : segment,
		);
		await ensureDirectory(mountRoot);
		const realMountRoot = await realpath(mountRoot);
		await ensureDirectory(localPath);
		await assertDirectChildDirectory(localPath, realMountRoot);

		const current = await probeMount(localPath, source, operationSignal);
		if (current.state === "conflict") {
			throw new Error(`sshfs mount path is occupied by another filesystem: ${localPath}`);
		}
		if (current.state === "matching" && current.healthy)
			return mountResult(host, localPath, "reused");
		if (current.state === "matching") {
			if (ownedMounts.get(localPath) !== source)
				throw new Error(
					`Unhealthy existing sshfs mount is not owned by this session: ${localPath}`,
				);
			const afterUnmount = await unmount(localPath, source, operationSignal);
			if (!afterUnmount) throw new Error(`Unable to unmount unhealthy sshfs mount: ${localPath}`);
			if (afterUnmount.state === "conflict")
				throw new Error(`sshfs mount path changed during unmount: ${localPath}`);
			ownedMounts.delete(localPath);
		}
		operationSignal.throwIfAborted();
		await assertDirectChildDirectory(localPath, realMountRoot);
		if ((await readdir(localPath)).length > 0)
			throw new Error(`sshfs mount path is not empty: ${localPath}`);
		await assertDirectChildDirectory(localPath, realMountRoot);

		ownedMounts.set(localPath, source);
		try {
			const result = await pi.exec(
				"sshfs",
				[
					"-o",
					"reconnect",
					"-o",
					"ServerAliveInterval=300",
					"-o",
					"ServerAliveCountMax=3",
					"-o",
					"BatchMode=yes",
					"-o",
					"StrictHostKeyChecking=accept-new",
					...(platform === "darwin" ? ["-o", "local"] : []),
					source,
					localPath,
				],
				{ timeout: SSHFS_TIMEOUT_MS, signal: operationSignal },
			);
			if (result.killed) {
				operationSignal.throwIfAborted();
				throw new Error("sshfs mount timed out");
			}
			operationSignal.throwIfAborted();
			if (result.code !== 0) {
				const detail = result.stderr.trim() || result.stdout.trim();
				throw new Error(
					`Failed to mount ${host}: ${detail || `sshfs exited with code ${result.code}`}`,
				);
			}
			const mounted = await waitForHealthyMount(localPath, source, operationSignal);
			if (mounted.state !== "matching" || !mounted.healthy) {
				throw new Error(`sshfs mounted ${host}, but the local mount is not healthy: ${localPath}`);
			}
		} catch (error) {
			await rollbackMount(localPath, source);
			if (isMissingBinaryError(error)) throw new Error("sshfs binary not found", { cause: error });
			throw error;
		}
		return mountResult(host, localPath, "mounted");
	};

	pi.registerTool({
		name: SSHFS_TOOL_NAME,
		label: "SSHFS",
		description: "Mount a remote root filesystem locally through sshfs and return its local path.",
		promptSnippet:
			"Mount a remote root filesystem locally, then use local file tools on the returned path.",
		promptGuidelines: [
			"After mounting, use `grep`, `edit`, `write`, `read`, `find`, and `ls` directly on paths under the returned local path.",
		],
		parameters: SSHFS_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params: Static<typeof SSHFS_PARAMETERS>, signal) {
			return await mount(params.host, signal);
		},
	});

	return {
		async dispose(): Promise<void> {
			const errors: unknown[] = [];
			for (const [localPath, source] of ownedMounts) {
				try {
					await cleanupOwnedMount(localPath, source);
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 0) throw new AggregateError(errors, "Unable to clean up SSHFS mounts");
		},
	};
}

async function probeFilesystemSource(
	pi: ExtensionAPI,
	localPath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await pi.exec("df", ["-P", localPath], {
		timeout: PROBE_TIMEOUT_MS,
		...(signal ? { signal } : {}),
	});
	if (result.killed) {
		signal?.throwIfAborted();
		throw new Error("sshfs filesystem probe timed out");
	}
	if (result.code !== 0) throw new Error(`Unable to inspect mount path: df exited ${result.code}`);
	const line = result.stdout.trim().split("\n").at(-1);
	return line?.trim().split(/\s+/, 1)[0];
}

function findMountEntry(output: string, localPath: string): MountEntry | undefined {
	const escapedPath = localPath
		.replaceAll("\\", "\\134")
		.replaceAll(" ", "\\040")
		.replaceAll("\t", "\\011");
	for (const line of output.split("\n")) {
		for (const path of [localPath, escapedPath]) {
			const separator = ` on ${path} `;
			const index = line.indexOf(separator);
			if (index < 0) continue;
			return {
				source: line.slice(0, index).trim(),
				metadata: line.slice(index + separator.length),
			};
		}
	}
	return undefined;
}

async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(`sshfs path must be a real directory: ${path}`);
	await chmod(path, 0o700);
}

async function assertDirectChildDirectory(path: string, realParent: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(`sshfs mount path must be a real directory: ${path}`);
	const resolved = await realpath(path);
	if (dirname(resolved) !== realParent)
		throw new Error(`sshfs mount path escapes its root: ${path}`);
}

function mountResult(
	host: string,
	localPath: string,
	status: SshfsToolDetails["status"],
): AgentToolResult<SshfsToolDetails> {
	return {
		content: [
			{
				type: "text",
				text: [
					"Remote root mounted.",
					`Home path: ${localPath}`,
					"Use `grep`, `edit`, `write`, `read`, `find`, and `ls` directly under this path to access remote files.",
				].join("\n"),
			},
		],
		details: { host, localPath, status },
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isMissingBinaryError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
