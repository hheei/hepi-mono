import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mock.agentDir,
}));

import {
	expandConfigPath,
	HINDSIGHT_DEFAULTS,
	loadHindsightConfig,
	resolveHindsightConfig,
	resolveRepoName,
} from "../../src/hindsight/config.js";

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("hindsight config resolution", () => {
	const base = { cwd: "/work/hepi-mono", repo: "hepi-mono" };

	it("stays disabled until the option is explicitly true", () => {
		expect(
			resolveHindsightConfig({ settings: undefined, env: {}, fallback: undefined, ...base }),
		).toBeUndefined();
		expect(
			resolveHindsightConfig({
				settings: { enabled: false, apiUrl: "http://x" },
				env: {},
				fallback: undefined,
				...base,
			}),
		).toBeUndefined();
		expect(
			resolveHindsightConfig({
				settings: { enabled: "true" },
				env: {},
				fallback: undefined,
				...base,
			}),
		).toBeUndefined();
	});

	it("derives a per-repository bank by default", () => {
		const resolved = resolveHindsightConfig({
			settings: { enabled: true },
			env: {},
			fallback: undefined,
			...base,
		});
		expect(resolved).toBeDefined();
		if (resolved === undefined) return;
		expect(resolved.config).toEqual(HINDSIGHT_DEFAULTS);
		expect(resolved.bankId).toBe("coding-agent::hepi-mono");
		expect(resolved.bankSource).toBe("derived");
		expect(resolved.isolationMode).toBe("dedicated-bank");
		expect(resolved.scopeTags).toEqual([]);
		expect(resolved.retainMetadata).toEqual({ project: "hepi-mono", cwd: "/work/hepi-mono" });
	});

	it("prefers settings over environment over the fallback file", () => {
		const resolved = resolveHindsightConfig({
			settings: { enabled: true, apiUrl: "http://settings", apiToken: "settings-token" },
			env: {
				HINDSIGHT_API_URL: "http://env",
				HINDSIGHT_API_TOKEN: "env-token",
				HINDSIGHT_BANK_ID: "env-bank",
			},
			fallback: { apiUrl: "http://file", bankId: "file-bank" },
			...base,
		});
		expect(resolved?.config.apiUrl).toBe("http://settings");
		expect(resolved?.config.apiToken).toBe("settings-token");
		// Env wins over the fallback file for the bank too.
		expect(resolved?.bankId).toBe("env-bank");
		expect(resolved?.bankSource).toBe("settings");

		const envOnly = resolveHindsightConfig({
			settings: { enabled: true },
			env: { HINDSIGHT_API_URL: "http://env" },
			fallback: { apiUrl: "http://file" },
			...base,
		});
		expect(envOnly?.config.apiUrl).toBe("http://env");
	});

	it("tags a shared bank with the repository scope and inherits its overrides", () => {
		const resolved = resolveHindsightConfig({
			settings: { enabled: true },
			env: {},
			fallback: {
				apiUrl: "http://oracle-kr:38888",
				bankId: "hheei",
				banks: {
					hheei: {
						retainTags: ["source:codex", "host:judy"],
						retainMetadata: { source_host: "judy" },
					},
				},
			},
			...base,
		});
		expect(resolved?.config.apiUrl).toBe("http://oracle-kr:38888");
		expect(resolved?.isolationMode).toBe("tagged-shared-bank");
		expect(resolved?.scopeTags).toEqual(["repo:hepi-mono"]);
		expect(resolved?.retainTags).toEqual(["repo:hepi-mono", "source:codex", "host:judy"]);
		expect(resolved?.retainMetadata).toEqual({
			project: "hepi-mono",
			cwd: "/work/hepi-mono",
			source_host: "judy",
		});
	});

	it("ignores bank overrides that belong to a different bank", () => {
		const resolved = resolveHindsightConfig({
			settings: { enabled: true, bankId: "other" },
			env: {},
			fallback: { bankId: "hheei", banks: { hheei: { retainTags: ["source:codex"] } } },
			...base,
		});
		expect(resolved?.bankId).toBe("other");
		expect(resolved?.retainTags).toEqual(["repo:hepi-mono"]);
	});

	it("routes by longest matching path prefix", () => {
		const resolved = resolveHindsightConfig({
			settings: { enabled: true },
			env: {},
			fallback: {
				mapPathToBank: { "/work": "broad", "/work/hepi-mono": "specific" },
				bankId: "static",
			},
			...base,
		});
		expect(resolved?.bankId).toBe("specific");
		expect(resolved?.bankSource).toBe("path-map");
		// A mapped bank is treated as shared: the repo tag still separates repositories.
		expect(resolved?.scopeTags).toEqual(["repo:hepi-mono"]);
	});

	it("falls back past an unmatching path map to the template", () => {
		const resolved = resolveHindsightConfig({
			settings: { enabled: true },
			env: {},
			fallback: {
				mapPathToBank: { "/elsewhere": "other" },
				bankIdTemplate: "coding-agent::{gitProject}",
			},
			...base,
		});
		expect(resolved?.bankId).toBe("coding-agent::hepi-mono");
		expect(resolved?.bankSource).toBe("template");
		expect(resolved?.isolationMode).toBe("dedicated-bank");
	});

	it("rejects malformed optional values instead of trusting them", () => {
		const resolved = resolveHindsightConfig({
			settings: {
				enabled: true,
				readTimeoutMs: -1,
				maxMemoryChars: 1.5,
				reflectBudget: "extreme",
				autoRecall: "yes",
				bankId: "   ",
				retainSessions: false,
			},
			env: {},
			fallback: undefined,
			...base,
		});
		expect(resolved?.config.readTimeoutMs).toBe(HINDSIGHT_DEFAULTS.readTimeoutMs);
		expect(resolved?.config.maxMemoryChars).toBe(HINDSIGHT_DEFAULTS.maxMemoryChars);
		expect(resolved?.config.reflectBudget).toBe(HINDSIGHT_DEFAULTS.reflectBudget);
		expect(resolved?.config.autoRecall).toBe(HINDSIGHT_DEFAULTS.autoRecall);
		expect(resolved?.config.retainSessions).toBe(false);
		// A blank bank id is not a bank id.
		expect(resolved?.bankId).toBe("coding-agent::hepi-mono");
	});

	it("expands home-relative config paths", () => {
		expect(expandConfigPath("~/.hindsight/coding-agent.json", "/work")).toMatch(
			/\/\.hindsight\/coding-agent\.json$/,
		);
		expect(expandConfigPath("relative.json", "/work")).toBe("/work/relative.json");
		expect(expandConfigPath("/abs/path.json", "/work")).toBe("/abs/path.json");
	});
});

describe("hindsight config loading", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/hindsight-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".git"), { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns undefined for a missing or disabled section", async () => {
		expect(await loadHindsightConfig(cwd, {})).toBeUndefined();
		writeJson(join(agentDir, "ext_settings.json"), {
			"pi-ext-memory": { hindsight: { enabled: false } },
		});
		expect(await loadHindsightConfig(cwd, {})).toBeUndefined();
	});

	it("never consults the fallback file while the section is disabled", async () => {
		const fallbackPath = join(root, "fallback.json");
		writeJson(fallbackPath, { bankId: "should-not-be-used" });
		writeJson(join(agentDir, "ext_settings.json"), {
			"pi-ext-memory": { hindsight: { enabled: false, configPath: fallbackPath } },
		});
		// A malformed fallback file would be logged if it were read; the disabled path
		// returns before touching it at all.
		writeFileSync(fallbackPath, "{ not json", "utf-8");
		expect(await loadHindsightConfig(cwd, {})).toBeUndefined();
	});

	it("degrades to defaults when the fallback file is malformed", async () => {
		const fallbackPath = join(root, "fallback.json");
		mkdirSync(join(fallbackPath, ".."), { recursive: true });
		writeFileSync(fallbackPath, "{ not json", "utf-8");
		writeJson(join(agentDir, "ext_settings.json"), {
			"pi-ext-memory": { hindsight: { enabled: true, configPath: fallbackPath } },
		});
		const resolved = await loadHindsightConfig(cwd, {});
		expect(resolved?.bankId).toBe("coding-agent::project");
		expect(resolved?.config.apiUrl).toBe(HINDSIGHT_DEFAULTS.apiUrl);
	});

	it("merges project settings and resolves the repository from the git root", async () => {
		const nested = join(cwd, "packages", "deep");
		mkdirSync(nested, { recursive: true });
		writeJson(join(nested, ".pi", "ext_settings.json"), {
			"pi-ext-memory": { hindsight: { enabled: true, bankId: "project-bank" } },
		});
		const resolved = await loadHindsightConfig(nested, {});
		expect(resolved?.bankId).toBe("project-bank");
		expect(resolved?.repo).toBe("project");
		expect(resolved?.scopeTags).toEqual(["repo:project"]);
	});
});

describe("resolveRepoName", () => {
	let root: string;

	beforeEach(() => {
		root = `${tmpdir()}/hindsight-repo-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses the repository root name from any subdirectory", async () => {
		const repo = join(root, "hepi-mono");
		const nested = join(repo, "packages", "pi-ext-memory");
		mkdirSync(nested, { recursive: true });
		mkdirSync(join(repo, ".git"), { recursive: true });
		expect(await resolveRepoName(nested)).toBe("hepi-mono");
	});

	it("accepts a worktree gitdir file", async () => {
		const repo = join(root, "worktree-checkout");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/x", "utf-8");
		expect(await resolveRepoName(repo)).toBe("worktree-checkout");
	});

	it("falls back to the directory name outside a repository", async () => {
		const plain = join(root, "scratch");
		mkdirSync(plain, { recursive: true });
		expect(await resolveRepoName(plain)).toBe("scratch");
	});
});
