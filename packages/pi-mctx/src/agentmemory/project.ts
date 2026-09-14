import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { AgentMemoryConfig } from "#core/config/schema/magic-context";

export type AgentMemoryProjectEnvironment = {
	AGENTMEMORY_PROJECT_NAME?: string | undefined;
	AGENT_ID?: string | undefined;
};

export type AgentMemoryIdentity = {
	project: string;
	agentId?: string | undefined;
};

const projectCache = new Map<string, string>();

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function canonicalPath(directory: string): string {
	const resolved = path.resolve(directory);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function findGitRoot(directory: string): string | undefined {
	let current = canonicalPath(directory);
	while (true) {
		if (existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Resolve the AgentMemory namespace from an explicit environment override, git root, then cwd. */
export function resolveAgentMemoryProject(
	directory: string,
	environment: AgentMemoryProjectEnvironment = process.env,
): string {
	const configured = nonEmpty(environment.AGENTMEMORY_PROJECT_NAME);
	if (configured) return configured;

	const canonical = canonicalPath(directory);
	const cached = projectCache.get(canonical);
	if (cached) return cached;
	const root = findGitRoot(canonical) ?? canonical;
	const project = path.basename(root) || root;
	projectCache.set(canonical, project);
	return project;
}

export function createAgentMemoryIdentityResolver(
	settings: Pick<AgentMemoryConfig, "agentId">,
	environment: AgentMemoryProjectEnvironment = process.env,
): (cwd: string) => AgentMemoryIdentity {
	return (cwd) => {
		const agentId = nonEmpty(environment.AGENT_ID) ?? nonEmpty(settings.agentId);
		return {
			project: resolveAgentMemoryProject(cwd, environment),
			...(agentId ? { agentId } : {}),
		};
	};
}

export function clearAgentMemoryProjectCache(): void {
	projectCache.clear();
}
