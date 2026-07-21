import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	PlanConfirmationAction,
	PlanConfirmationResult,
} from "../../../src/modules/plan/confirmation.js";
import { createPlanFeature } from "../../../src/modules/plan/feature.js";
import { PLAN_MESSAGE_TYPE } from "../../../src/modules/plan/model.js";

const selected = (action: PlanConfirmationAction): PlanConfirmationResult => ({
	status: "selected",
	action,
	model: { id: "model", name: "Model" },
	thinkingLevel: "high",
});
interface Options {
	action?: PlanConfirmationAction;
	cancelled?: boolean;
	error?: Error;
	compactError?: boolean;
	mode?: string;
	custom?: boolean;
}
function fixture(options: Options = {}) {
	const commands = new Map<string, (a: string, c: ExtensionCommandContext) => Promise<void>>(),
		completions = new Map<string, (p: string) => unknown[]>(),
		handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown> | unknown>>(),
		entries: Array<Record<string, unknown>> = [],
		statuses = new Map<string, string | undefined>();
	const sent: string[] = [],
		notifications: string[] = [],
		compacted: Array<{ onComplete?: () => void; onError?: () => void }> = [],
		childSent: string[] = [];
	let id = 0,
		customCalls = 0;
	const pi = {
		registerCommand(
			n: string,
			s: {
				handler: (a: string, c: ExtensionCommandContext) => Promise<void>;
				getArgumentCompletions?: (p: string) => unknown[];
			},
		) {
			commands.set(n, s.handler);
			if (s.getArgumentCompletions) completions.set(n, s.getArgumentCompletions);
		},
		on(n: string, h: (e: unknown, c: unknown) => Promise<unknown> | unknown) {
			handlers.set(n, [...(handlers.get(n) ?? []), h]);
		},
		appendEntry(t: string, d: unknown) {
			entries.push({ id: `b-${++id}`, type: "custom", customType: t, data: d });
		},
		sendMessage(m: { customType: string; content: string }) {
			entries.push({
				id: `p-${++id}`,
				type: "custom_message",
				customType: m.customType,
				content: m.content,
			});
		},
		sendUserMessage(c: string) {
			sent.push(c);
		},
		getThinkingLevel: () => "high",
		setThinkingLevel: () => undefined,
		getModel: () => ({ id: "model", name: "Model" }),
		setModel: async () => true,
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.mode !== "rpc",
		signal: undefined,
		model: { id: "model", name: "Model" },
		modelRegistry: { getAvailable: () => [{ id: "model", name: "Model" }] },
		ui: {
			setStatus(k: string, v: string | undefined) {
				statuses.set(k, v);
			},
			notify(m: string) {
				notifications.push(m);
			},
			custom:
				options.custom === false
					? undefined
					: async (
							factory: (
								t: { requestRender(): void },
								th: unknown,
								k: unknown,
								d: (r: PlanConfirmationResult) => void,
							) => unknown,
						) => {
							customCalls++;
							factory(
								{ requestRender() {} },
								{
									fg: (_: string, x: string) => x,
									bold: (x: string) => x,
									dim: (x: string) => x,
									italic: (x: string) => x,
									strikethrough: (x: string) => x,
								},
								{},
								() => undefined,
							);
							return options.action ? selected(options.action) : undefined;
						},
		},
		sessionManager: {
			getSessionId: () => "plan-session",
			getSessionFile: () => "/tmp/plan-session.jsonl",
			getBranch: () => entries,
		},
		newSession: async (o: {
			withSession: (s: { sendUserMessage: (c: string) => void }) => Promise<void>;
		}) => {
			if (options.error) throw options.error;
			await o.withSession({ sendUserMessage: (c) => childSent.push(c) });
			return { cancelled: options.cancelled ?? false };
		},
		compact(o: { onComplete?: () => void; onError?: () => void }) {
			if (options.compactError) throw Error("compact failed");
			compacted.push(o);
		},
	} as unknown as ExtensionContext & ExtensionCommandContext;
	const feature = createPlanFeature(pi);
	return {
		pi,
		feature,
		ctx,
		commands,
		completions,
		handlers,
		entries,
		statuses,
		sent,
		notifications,
		compacted,
		childSent,
		get customCalls() {
			return customCalls;
		},
	};
}
function start(h: ReturnType<typeof fixture>): void {
	h.feature.start({ pi: h.pi, ctx: h.ctx, registry: {}, requestRender() {}, close() {} } as never);
}
async function emit(h: ReturnType<typeof fixture>, e: string, v: unknown): Promise<void> {
	for (const fn of h.handlers.get(e) ?? []) await fn(v, h.ctx);
}
const planEvent = {
	messages: [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "<proposed_plan>\n# Title\n\nImplement it\n</proposed_plan>" },
			],
		},
	],
};
describe("Plan feature", () => {
	test("saves artifact and refines via custom UI", async () => {
		const h = fixture({ action: "refine" });
		start(h);
		await h.commands.get("plan")!("inspect", h.ctx);
		await emit(h, "agent_end", planEvent);
		expect(h.entries.some((e) => e.customType === PLAN_MESSAGE_TYPE)).toBe(true);
		expect(h.sent.at(-1)).toContain("The user requests refine the plan.");
		expect(h.statuses.get("plan")).toBe("plan-refine");
	});
	test("dispatches implementation actions", async () => {
		for (const action of ["continue", "compact", "new"] as const) {
			const h = fixture({ action });
			start(h);
			await h.commands.get("plan")!("inspect", h.ctx);
			await emit(h, "agent_end", planEvent);
			if (action === "compact") {
				expect(h.compacted).toHaveLength(1);
				h.compacted[0]!.onComplete?.();
			}
			if (action === "continue")
				expect(h.sent.at(-1)).toContain("normal tool permissions are restored");
			if (action === "new")
				expect(h.childSent.at(-1)).toContain("normal tool permissions are restored");
		}
	});
	test("restores refinement after failures", async () => {
		for (const o of [
			{ action: "new" as const, cancelled: true },
			{ action: "new" as const, error: Error("no child") },
			{ action: "compact" as const, compactError: true },
		]) {
			const h = fixture(o);
			start(h);
			await h.commands.get("plan")!("inspect", h.ctx);
			await emit(h, "agent_end", planEvent);
			expect(h.statuses.get("plan")).toBe("plan-refine");
		}
	});
	test("cancellation and non-TUI give guidance", async () => {
		const h = fixture({ custom: false });
		start(h);
		await h.commands.get("plan")!("inspect", h.ctx);
		await emit(h, "agent_end", planEvent);
		expect(h.statuses.get("plan")).toBe("plan");
		const n = fixture({ mode: "rpc" });
		start(n);
		await n.commands.get("plan")!("inspect", n.ctx);
		await emit(n, "agent_end", planEvent);
		expect(n.notifications.at(-1)).toContain("Use /plan implement");
	});
	test("provides completions", () => {
		const h = fixture();
		start(h);
		expect(h.completions.get("plan")!("").map((i) => (i as { value: string }).value)).toEqual([
			"edit",
			"show",
			"stop",
			"implement",
		]);
	});
	test("stops Plan mode", async () => {
		const h = fixture();
		start(h);
		await h.commands.get("plan")!("stop", h.ctx);
		expect(h.notifications).toContain("※ Plan mode stopped");
	});
});
