import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const ParamsSchema = Type.Object({
	content: Type.String({ description: "The durable fact to save." }),
	type: Type.Optional(
		Type.Union([
			Type.Literal("pattern"),
			Type.Literal("preference"),
			Type.Literal("architecture"),
			Type.Literal("bug"),
			Type.Literal("workflow"),
			Type.Literal("fact"),
		]),
	),
});

type SaveParams = Static<typeof ParamsSchema>;

export function createMemorySaveTool(options: {
	queueMemory(input: {
		readonly cwd: string;
		readonly content: string;
		readonly type?: string | undefined;
	}): Promise<{ status: "queued" | "delivered" | "failed"; id: string }>;
}): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "mctx_memory",
		label: "Magic Context: Memory",
		description: "Queue an explicit fact for durable AgentMemory delivery.",
		parameters: ParamsSchema,
		async execute(_id, params: SaveParams, _signal, _onUpdate, ctx) {
			const content = params.content.trim();
			if (content.length === 0) {
				return {
					content: [{ type: "text" as const, text: "rejected: content is required" }],
					details: { status: "rejected" as const },
				};
			}
			try {
				const queued = await options.queueMemory({
					cwd: ctx.cwd,
					content,
					...(params.type?.trim() ? { type: params.type.trim() } : {}),
				});
				return {
					content: [{ type: "text" as const, text: `${queued.status}: ${queued.id}` }],
					details: { status: queued.status, id: queued.id },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `rejected: ${message}` }],
					details: { status: "rejected" as const, reason: "remember failed" },
				};
			}
		},
	};
}
