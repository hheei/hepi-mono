import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface SshHostRecord {
	alias: string;
	user?: string;
	hostname: string;
	display: string;
}

export function validateSshHostPattern(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("host arguments must be an object");
	}
	const pattern = (value as Record<string, unknown>).ssh_host;
	if (typeof pattern !== "string" || !pattern.trim()) {
		throw new Error("host.ssh_host must be a non-empty string");
	}
	return pattern.trim();
}

export async function findConfiguredHosts(
	pattern: string,
	configPath = join(homedir(), ".ssh", "config"),
): Promise<SshHostRecord[]> {
	const hosts: SshHostRecord[] = [];
	await collectHostsFromConfig(configPath, new Set<string>(), hosts, new Set<string>());
	if (pattern === "*") return hosts;
	const matcher = new RegExp(pattern);
	return hosts.filter((host) => matcher.test(host.alias));
}

async function collectHostsFromConfig(
	configPath: string,
	seenFiles: Set<string>,
	hosts: SshHostRecord[],
	seenHosts: Set<string>,
): Promise<void> {
	if (seenFiles.has(configPath)) return;
	seenFiles.add(configPath);

	const raw = await readFile(configPath, "utf8").catch(() => "");
	if (!raw) return;

	const baseDir = configPath.includes("/") ? configPath.slice(0, configPath.lastIndexOf("/")) : ".";
	let currentAliases: string[] = [];
	let currentUser: string | undefined;
	let currentHostName: string | undefined;

	const flushCurrent = () => {
		for (const alias of currentAliases) {
			if (seenHosts.has(alias)) continue;
			seenHosts.add(alias);
			const hostname = currentHostName ?? alias;
			const user = currentUser;
			hosts.push({
				alias,
				user,
				hostname,
				display: `${alias} (${user ? `${user}@` : ""}${hostname})`,
			});
		}
	};

	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const includeMatch = line.match(/^Include\s+(.+)$/i);
		if (includeMatch) {
			flushCurrent();
			currentAliases = [];
			currentUser = undefined;
			currentHostName = undefined;
			for (const token of splitConfigArgs(includeMatch[1] ?? "")) {
				if (token.includes("*") || token.includes("?")) continue;
				const includePath = token.startsWith("~")
					? join(homedir(), token.slice(1))
					: isAbsolute(token)
						? token
						: join(baseDir, token);
				await collectHostsFromConfig(includePath, seenFiles, hosts, seenHosts);
			}
			continue;
		}

		const hostMatch = line.match(/^Host\s+(.+)$/i);
		if (hostMatch) {
			flushCurrent();
			currentAliases = [];
			currentUser = undefined;
			currentHostName = undefined;
			for (const token of splitConfigArgs(hostMatch[1] ?? "")) {
				if (!isConcreteHostToken(token)) continue;
				currentAliases.push(token);
			}
			continue;
		}

		if (currentAliases.length === 0) continue;

		const userMatch = line.match(/^User\s+(.+)$/i);
		if (userMatch) {
			currentUser = splitConfigArgs(userMatch[1] ?? "")[0];
			continue;
		}

		const hostNameMatch = line.match(/^HostName\s+(.+)$/i);
		if (hostNameMatch) {
			currentHostName = splitConfigArgs(hostNameMatch[1] ?? "")[0];
		}
	}

	flushCurrent();
}

function splitConfigArgs(value: string): string[] {
	return value
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function isConcreteHostToken(token: string): boolean {
	return !(token.startsWith("!") || /[*?]/.test(token));
}
