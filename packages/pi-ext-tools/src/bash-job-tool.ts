import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { FffRuntimeState } from "./fff/lifecycle.js";

const Params = Type.Object(
	{
		action: Type.Union([Type.Literal("status"), Type.Literal("logs"), Type.Literal("stop")]),
		id: Type.String(),
	},
	{ additionalProperties: false },
);
type Params = Static<typeof Params>;
export function registerBashJobTool(pi: ExtensionAPI, state: FffRuntimeState): void {
	const tool: ToolDefinition<typeof Params, unknown> = {
		name: "bash_job",
		label: "bash_job",
		description: "Inspect or stop an extension-owned asynchronous Bash job.",
		parameters: Params,
		async execute(_id, params: Params) {
			const jobs = state.getBashJobs();
			if (!jobs)
				return {
					content: [{ type: "text", text: "No active Bash job session" }],
					details: { error: "session_unavailable" },
				};
			const job = params.action === "stop" ? jobs.stop(params.id) : jobs.get(params.id);
			if (!job)
				return {
					content: [{ type: "text", text: `Unknown Bash job: ${params.id}` }],
					details: { error: "not_found" },
				};
			const metadata = { ...job, output: undefined };
			return {
				content: [
					{
						type: "text",
						text:
							params.action === "logs"
								? JSON.stringify({ id: job.id, status: job.status, artifact: job.outputArtifact })
								: JSON.stringify(metadata),
					},
				],
				details: metadata,
			};
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "bash_job",
			owner: "@hheei/pi-ext-tools",
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}
export { Params as BashJobInput };
