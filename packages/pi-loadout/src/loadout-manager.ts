import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ResourcePatternStore } from "./pattern-store.js";
import type {
	LoadoutItem,
	ProjectOverrideState,
	ResourceCategory,
	ResourceOrigin,
} from "./types.js";

const BUILTIN_PATH_PREFIX = "builtin:";

export interface LoadoutManagerOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly settingsManager?: SettingsManager;
	readonly builtinExtensions?: readonly string[];
}

const skillDescriptionCache = new Map<
	string,
	{ readonly mtimeMs: number; readonly desc: string | undefined }
>();

function extractSkillDescription(skillPath: string): string | undefined {
	try {
		if (!existsSync(skillPath)) return undefined;
		const stat = statSync(skillPath);
		const cached = skillDescriptionCache.get(skillPath);
		if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
			return cached.desc;
		}
		const content = readFileSync(skillPath, "utf8");
		let desc: string | undefined;
		const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
		if (fmMatch?.[1]) {
			const descMatch = /^description:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/mu.exec(fmMatch[1]);
			if (descMatch) {
				const val = (descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "").trim();
				if (val) desc = val;
			}
		}
		if (desc === undefined) {
			const lines = content
				.replace(/^---\r?\n[\s\S]*?\r?\n---/u, "")
				.trim()
				.split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed && !trimmed.startsWith("#")) {
					desc = trimmed;
					break;
				}
			}
		}
		skillDescriptionCache.set(skillPath, { mtimeMs: stat.mtimeMs, desc });
		return desc;
	} catch {
		return undefined;
	}
}

export class LoadoutManager {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	readonly builtinExtensions: readonly string[];
	readonly store: ResourcePatternStore;

	#items: LoadoutItem[] = [];

	constructor(options: LoadoutManagerOptions) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.settingsManager =
			options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.builtinExtensions = options.builtinExtensions ?? [];
		this.store = new ResourcePatternStore({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
	}

	get items(): readonly LoadoutItem[] {
		return this.#items;
	}

	setItemsForTest(items: LoadoutItem[]): void {
		this.#items = items;
	}

	isProjectTrusted(): boolean {
		return this.settingsManager.isProjectTrusted();
	}

	async refresh(): Promise<void> {
		const globalSettingsManager = SettingsManager.create(this.cwd, this.agentDir, {
			projectTrusted: false,
		});

		const globalPm = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: globalSettingsManager,
			builtinExtensions: [...this.builtinExtensions],
		});
		const globalResolved = await globalPm.resolve();

		const projectPm = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			builtinExtensions: [...this.builtinExtensions],
		});
		const projectResolved = this.settingsManager.isProjectTrusted()
			? await projectPm.resolve()
			: globalResolved;

		const nextItems: LoadoutItem[] = [];

		const addCategory = (
			category: ResourceCategory,
			resolvedList: typeof globalResolved.skills,
		) => {
			for (const res of resolvedList) {
				const { path, metadata } = res;
				const origin: ResourceOrigin =
					metadata.source === "builtin"
						? "builtin"
						: metadata.origin === "package"
							? "package"
							: metadata.scope === "project"
								? "project"
								: "user";

				const fileName = basename(path);
				const parentFolder = basename(dirname(path));
				let displayName: string;
				if (metadata.source === "builtin") {
					displayName = path.slice(BUILTIN_PATH_PREFIX.length);
				} else if (category === "skills" && fileName === "SKILL.md") {
					displayName = parentFolder;
				} else if (category === "extensions" && parentFolder !== "extensions") {
					displayName = `${parentFolder}/${fileName}`;
				} else {
					displayName = fileName;
				}

				const globalItem = globalResolved[category as keyof typeof globalResolved]?.find(
					(g) => g.path === path,
				);
				const projectItem = projectResolved[category as keyof typeof projectResolved]?.find(
					(p) => p.path === path,
				);

				const globalEnabled = globalItem?.enabled ?? true;
				const effectiveEnabled = projectItem?.enabled ?? globalEnabled;

				const projectOverride = this.store.resolveProjectOverride(category, path, metadata);

				let description: string | undefined;
				if (category === "skills") {
					description = extractSkillDescription(path);
				}

				nextItems.push({
					id: `${category}:${path}`,
					category,
					name: displayName,
					path,
					origin,
					source: metadata.source,
					...(metadata.baseDir ? { baseDir: metadata.baseDir } : {}),
					...(description ? { description } : {}),
					globalEnabled,
					projectOverride,
					effectiveEnabled,
				});
			}
		};

		addCategory("skills", globalResolved.skills);
		addCategory("extensions", globalResolved.extensions);
		addCategory("prompts", globalResolved.prompts);
		addCategory("themes", globalResolved.themes);

		this.#items = nextItems;
	}

	toggleGlobal(item: LoadoutItem): void {
		this.store.toggleGlobal(item);
	}

	cycleProjectOverride(item: LoadoutItem): ProjectOverrideState {
		return this.store.cycleProjectOverride(item);
	}

	async flush(): Promise<void> {
		await this.store.flush();
	}
}
