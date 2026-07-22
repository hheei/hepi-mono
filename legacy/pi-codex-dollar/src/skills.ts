import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SUGGESTIONS } from "./settings.js";
import { bareSkillName, normalize } from "./text.js";
import type { SkillCommand, SkillEntry, SkillSourceInfo, SkillSuggestion } from "./types.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const packageSkillIndexes = new Map<string, Map<string, string>>();
const skillEntriesCache = new WeakMap<readonly SkillCommand[], SkillEntry[]>();
const skillPathMapCache = new WeakMap<readonly SkillCommand[], Map<string, string>>();

function normalizeSourceLabel(label: unknown): string | undefined {
	const text = String(label ?? "").trim();
	if (!text) return undefined;
	return text.slice(0, 1).toUpperCase() + text.slice(1).toLowerCase();
}

function packageNpmRoots(): string[] {
	const roots = new Set<string>();
	const envRoots = String(
		process.env.PI_CODEX_DOLLAR_NPM_ROOTS ?? process.env.CODEX_DOLLAR_AUTCOMPLETE_NPM_ROOTS ?? "",
	)
		.split(delimiter)
		.map((root) => root.trim())
		.filter(Boolean);

	for (const root of envRoots) roots.add(resolve(root));
	roots.add(resolve(process.cwd(), "npm/node_modules"));
	roots.add(resolve(homedir(), ".pi/agent/npm/node_modules"));
	roots.add(resolve(EXTENSION_DIR, "../../..", "npm/node_modules"));

	const installedPackageRoot = resolve(EXTENSION_DIR, "../../..");
	if (basename(installedPackageRoot) === "node_modules") roots.add(installedPackageRoot);
	return [...roots];
}

function packageDirs(root: string): string[] {
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const dirs: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const entryPath = join(root, entry.name);
		if (entry.name.startsWith("@")) {
			let scopedEntries: Dirent<string>[];
			try {
				scopedEntries = readdirSync(entryPath, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const scopedEntry of scopedEntries) {
				if (scopedEntry.isDirectory()) dirs.push(join(entryPath, scopedEntry.name));
			}
		} else {
			dirs.push(entryPath);
		}
	}

	return dirs;
}

function packageSkillIndex(): Map<string, string> {
	const cacheKey =
		process.env.PI_CODEX_DOLLAR_NPM_ROOTS ?? process.env.CODEX_DOLLAR_AUTCOMPLETE_NPM_ROOTS ?? "";
	const cached = packageSkillIndexes.get(cacheKey);
	if (cached) return cached;

	const index = new Map<string, string>();
	for (const root of packageNpmRoots()) {
		for (const packageDir of packageDirs(root)) {
			let skillEntries: Dirent<string>[];
			try {
				skillEntries = readdirSync(join(packageDir, "skills"), { withFileTypes: true });
			} catch {
				continue;
			}

			for (const skillEntry of skillEntries) {
				if (!skillEntry.isDirectory()) continue;
				const skillName = skillEntry.name;
				if (index.has(skillName)) continue;

				const candidate = join(packageDir, "skills", skillName, "SKILL.md");
				if (existsSync(candidate)) index.set(skillName, candidate);
			}
		}
	}

	packageSkillIndexes.set(cacheKey, index);
	return index;
}

function packageSkillPath(skillName: unknown): string | undefined {
	const normalizedName = String(skillName ?? "").replace(/[/]/g, "");
	if (!normalizedName) return undefined;
	return packageSkillIndex().get(normalizedName);
}

function normalizeSkillDescription(description: unknown): {
	source: string | undefined;
	description: string;
} {
	const text = String(description ?? "").trim();
	const match = text.match(/^\((User|Project|Extension)\)\s*-\s*(.*)$/i);
	if (!match) return { source: undefined, description: text };

	return { source: normalizeSourceLabel(match[1]), description: match[2] ?? "" };
}

function formatSourceLabel(
	sourceInfo: SkillSourceInfo | undefined,
	sourceHint: string | undefined,
	skillName: string,
): string {
	const provenance = [sourceInfo?.path, sourceInfo?.baseDir, sourceInfo?.source]
		.filter(Boolean)
		.join(" ");
	const hasConcretePath = Boolean(sourceInfo?.path || sourceInfo?.baseDir);

	if (sourceInfo?.origin === "package") return "Extension";
	if (/\bnode_modules\b/.test(provenance) || /^npm:/.test(String(sourceInfo?.source ?? "")))
		return "Extension";
	if (hasConcretePath && sourceInfo?.scope === "user") return "User";
	if (hasConcretePath && sourceInfo?.scope === "project") return "Project";
	if (sourceHint === "Extension") return "Extension";
	if (packageSkillPath(skillName)) return "Extension";
	if (sourceInfo?.scope === "user") return "User";
	if (sourceInfo?.scope === "project") return "Project";
	if (sourceHint) return sourceHint;

	const fallback = sourceInfo?.scope ?? sourceInfo?.origin ?? sourceInfo?.source ?? "unknown";
	return normalizeSourceLabel(fallback) ?? "Unknown";
}

function getSkillEntries(commands: readonly SkillCommand[]): SkillEntry[] {
	const cached = skillEntriesCache.get(commands);
	if (cached) return cached;

	const entries = commands
		.filter((command) => command?.source === "skill" && command.name)
		.map((command, index) => {
			const normalizedDescription = normalizeSkillDescription(command.description);
			const name = bareSkillName(command.name);

			return {
				index,
				name,
				normalizedName: normalize(name),
				source: formatSourceLabel(command.sourceInfo, normalizedDescription.source, name),
				description: normalizedDescription.description,
				value: `$${name}`,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index);

	skillEntriesCache.set(commands, entries);
	return entries;
}

function formatSkillItem(entry: SkillEntry): SkillSuggestion {
	return {
		value: entry.value,
		label: entry.name,
		description: entry.description
			? `(${entry.source}) - ${entry.description}`
			: `(${entry.source})`,
	};
}

export function getSkillPathMap(commands: readonly SkillCommand[]): Map<string, string> {
	const cached = skillPathMapCache.get(commands);
	if (cached) return cached;

	const skills = new Map<string, string>();
	for (const command of commands) {
		if (command?.source !== "skill" || !command.name) continue;
		const skillName = bareSkillName(command.name);
		const skillPath = command.sourceInfo?.path ?? packageSkillPath(skillName);
		if (!skillPath || skills.has(skillName)) continue;
		skills.set(skillName, skillPath);
	}

	skillPathMapCache.set(commands, skills);
	return skills;
}

export function getSkillSuggestions(
	commands: readonly SkillCommand[],
	query: string,
	maxSuggestions = MAX_SUGGESTIONS,
): SkillSuggestion[] {
	const normalizedQuery = normalize(query).trim();
	return getSkillEntries(commands)
		.filter((entry) => !normalizedQuery || entry.normalizedName.startsWith(normalizedQuery))
		.slice(0, maxSuggestions)
		.map(formatSkillItem);
}
