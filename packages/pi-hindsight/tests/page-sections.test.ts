import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import { createHindsightPageSectionService } from "../extensions/lifecycle/page-sections.js";
import type { HindsightLikeClient, ResolvedConfig } from "../extensions/types.js";

function config(): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		setupComplete: true,
		banks: {
			...DEFAULT_CONFIG.banks,
			project: { ...DEFAULT_CONFIG.banks.project, bankId: "project-bank", derive: "manual" },
		},
	};
}

function dependencies(
	overrides: {
		readonly tree?: unknown;
		readonly page?: unknown;
		readonly state?: { readonly owner: string; readonly generation?: string };
	} = {},
): {
	readonly deps: Parameters<typeof createHindsightPageSectionService>[0];
	readonly treeCalls: { value: number };
	readonly pageCalls: { value: number };
} {
	const treeCalls = { value: 0 };
	const pageCalls = { value: 0 };
	const client: HindsightLikeClient = {
		retain: async () => undefined,
		recall: async () => ({ results: [] }),
		reflect: async () => ({ text: "" }),
		getKnowledgePageTree: async () => {
			treeCalls.value++;
			return (
				overrides.tree ?? {
					roots: [
						{
							id: "folder-1",
							kind: "folder",
							name: "Architecture",
							children: [
								{
									id: "page-1",
									kind: "page",
									name: "Ownership",
									tags: ["architecture"],
									timestamp: "2026-08-07T00:00:00Z",
								},
							],
						},
					],
				}
			);
		},
		getKnowledgePage: async () => {
			pageCalls.value++;
			return (
				overrides.page ?? {
					id: "page-1",
					name: "Ownership",
					timestamp: "2026-08-07T00:00:00Z",
					markdown:
						"---\ntype: architecture\n---\n# Ownership\nKeep owners explicit.\n\n## Boundaries\nKeep package boundaries durable.",
				}
			);
		},
	};
	const deps = {
		getClient: () => client,
		getConfig: config,
		getProjectBankId: () => "project-bank",
		getCwd: () => "/repo",
		getInjectionState: () => overrides.state ?? { owner: "mctx-owned", generation: "generation-1" },
	};
	return { deps, treeCalls, pageCalls };
}

test("loads validated nested pages into scoped sections without hot-path I/O", async (): Promise<void> => {
	const { deps, treeCalls, pageCalls } = dependencies();
	const handle = await createHindsightPageSectionService(deps, new AbortController().signal);
	expect(handle).toBeDefined();
	if (handle === undefined) throw new Error("Expected page capability");
	expect(treeCalls.value).toBe(1);
	expect(pageCalls.value).toBe(1);

	const result = await handle.service.getPageSections({
		lease: { owner: "mctx-owned", generation: "generation-1", token: "token" },
		projectId: "git:project",
		signal: new AbortController().signal,
	});
	expect(result.kind).toBe("sections");
	if (result.kind !== "sections") throw new Error("Expected cached sections");
	expect(result.sections).toHaveLength(2);
	expect(result.sections[0]).toMatchObject({
		id: "knowledge-page:page-1:section:0",
		heading: "Ownership",
		text: "Keep owners explicit.",
		provenance: [
			"bank:project-bank",
			"knowledge-page:page-1",
			"page-section:0",
			"tags:architecture",
		],
	});
	expect(result.sections[0]?.scopeTags.length).toBeGreaterThan(0);
	expect(treeCalls.value).toBe(1);
	expect(pageCalls.value).toBe(1);

	await handle.refresh(new AbortController().signal);
	expect(treeCalls.value).toBe(2);
	expect(pageCalls.value).toBe(2);
});

test("rejects malformed page responses and refuses stale leases", async (): Promise<void> => {
	const malformed = dependencies({
		page: { id: "other-page", name: "Ownership", markdown: "# bad" },
	});
	expect(
		await createHindsightPageSectionService(malformed.deps, new AbortController().signal),
	).toBeUndefined();

	const { deps } = dependencies();
	const handle = await createHindsightPageSectionService(
		{
			...deps,
			getInjectionState: () => ({ owner: "hindsight-owned", generation: "generation-1" }),
		},
		new AbortController().signal,
	);
	expect(handle).toBeDefined();
	if (handle === undefined) throw new Error("Expected page capability");
	await expect(
		handle.service.getPageSections({
			lease: { owner: "mctx-owned", generation: "generation-1", token: "token" },
			projectId: "git:project",
			signal: new AbortController().signal,
		}),
	).resolves.toMatchObject({ kind: "unavailable" });
});
