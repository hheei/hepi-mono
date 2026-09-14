import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { AgentMemoryClientPort } from "../agentmemory/client";
import type { AgentMemoryIdentity } from "../agentmemory/runtime";

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
	client: AgentMemoryClientPort;
	identity: (cwd: string) => AgentMemoryIdentity;
}): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "mctx_memory",
		label: "Magic Context: Memory",
		description: "Save an explicit fact to the upstream AgentMemory service.",
		parameters: ParamsSchema,
		async execute(_id, params: SaveParams, _signal, _onUpdate, ctx) {
			const content = params.content.trim();
			const identity = options.identity(ctx.cwd);
			if (content.length === 0 || identity.project.length === 0) {
				return {
					content: [{ type: "text" as const, text: "rejected: content and project are required" }],
					details: { status: "rejected" as const },
				};
			}
			try {
				const remembered = await options.client.remember({
					content,
					project: identity.project,
					...(identity.agentId ? { agentId: identity.agentId } : {}),
					...(params.type?.trim() ? { type: params.type.trim() } : {}),
				});
				return {
					content: [{ type: "text" as const, text: `saved: ${remembered.memory.id}` }],
					details: { status: "saved" as const, id: remembered.memory.id },
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
