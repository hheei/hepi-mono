import type { ProcessRunner, SessionManager, SshMountResult } from "./session-manager.js";
import { validateHost } from "./ssh-exec.js";

export interface SshMountArgs {
	host: string;
}

export function validateSshMountArgs(value: unknown): SshMountArgs {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("ssh_mount arguments must be an object");
	}

	const record = value as Record<string, unknown>;
	if (typeof record.host !== "string" || record.host.trim() === "") {
		throw new Error("ssh_mount.host must be a non-empty string");
	}

	return { host: validateHost(record.host) };
}

export async function executeSshMount(
	manager: SessionManager,
	args: SshMountArgs,
	runner: ProcessRunner,
): Promise<SshMountResult> {
	return await manager.ensureMounted(validateHost(args.host), runner);
}
