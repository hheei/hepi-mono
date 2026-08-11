import { describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "#core/features/memory/project-identity";
import { updateSessionMeta } from "#core/features/storage-meta";
import { setSessionWorkMetrics } from "#core/features/storage-meta-persisted";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { buildPiStatusDetail, showStatusDialog } from "../../src/dialogs/status-dialog";

describe("Pi status dialog", () => {
	it("displays usage against the output-reserved safe window", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-reserved-window";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 50_000,
					percent: 50,
					contextWindow: 100_000,
				}),
				getSystemPrompt: () => "system prompt",
			};

			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				sessionId,
			);
			expect(detail.contextLimit).toBe(80_000);
			expect(detail.usagePercentage).toBe(62.5);
		} finally {
			closeQuietly(db);
		}
	});

	it("hides stale token attribution after resume", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-resume-stale-attribution";
			updateSessionMeta(db, sessionId, { toolCallTokens: 415_500 });
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 32_000,
					percent: 40,
					contextWindow: 100_000,
				}),
				getSystemPrompt: () => "system prompt",
				ui: {
					async custom(factory: unknown) {
						const makeComponent = factory as (
							tui: { requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ requestRender: () => undefined },
							{ fg: (_name, text) => text, bold: (text) => text },
							undefined,
							() => undefined,
						);
						rendered.push(component.render(100));
						component.dispose?.();
						return undefined;
					},
				},
			};

			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});

			const text = rendered.flat().join("\n");
			expect(text).toContain("Context  40.0%");
			expect(text).not.toContain("Tool Calls");
			expect(text).not.toContain("█");
		} finally {
			closeQuietly(db);
		}
	});
	it("renders stored work metrics", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-work";
			setSessionWorkMetrics(db, sessionId, 1200, 9800);
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext(sessionId),
				ui: {
					async custom(factory: unknown) {
						const makeComponent = factory as (
							tui: { requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ requestRender: () => undefined },
							{ fg: (_name, text) => text, bold: (text) => text },
							undefined,
							() => undefined,
						);
						rendered.push(component.render(100));
						component.dispose?.();
						return undefined;
					},
				},
				getSystemPrompt: () => "system prompt",
			};

			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});

			const text = rendered.flat().join("\n");
			expect(text).toContain("Work tokens 1.2K new · 9.8K total input");
			expect(text).not.toContain("Tool Calls");
			expect(text).not.toContain("System");
			expect(text).not.toContain("█");
		} finally {
			closeQuietly(db);
		}
	});
});
