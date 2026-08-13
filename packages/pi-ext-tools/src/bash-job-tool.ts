import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { createToolTui, type ToolTui } from "./pretty/frame.js";

const OWNER = "@hheei/pi-ext-tools";
const BASH_JOB_DESCRIPTION = "Inspect or stop an extension-owned asynchronous Bash job.";
const NO_ACTIVE_JOB_SESSION = "No active Bash job session";

const Params = Type.Object(
	{
		action: Type.Union([Type.Literal("status"), Type.Literal("logs"), Type.Literal("stop")]),
		id: Type.String(),
	},
	{ additionalProperties: false },
);
type Params = Static<typeof Params>;
export function registerBashJobTool(
	pi: ExtensionAPI,
	state: FffRuntimeState,
	tui: ToolTui = createToolTui(),
): void {
	const tool: ToolDefinition<typeof Params, unknown> = {
		name: "bash_job",
		label: "bash_job",
		description: BASH_JOB_DESCRIPTION,
		parameters: Params,
		async execute(_id, params: Params) {
			const jobs = state.getBashJobs();
			if (!jobs)
				return {
					content: [{ type: "text", text: NO_ACTIVE_JOB_SESSION }],
					details: { error: "session_unavailable" },
				};
			const job = params.action === "stop" ? jobs.stop(params.id) : jobs.get(params.id);
			if (!job)
				return {
					content: [{ type: "text", text: `Unknown Bash job: ${params.id}` }],
					details: { error: "not_found" },
				};
			const metadata = {
				id: job.id,
				command: job.command,
				cwd: job.cwd,
				status: job.status,
				exitCode: job.exitCode,
				startedAt: job.startedAt,
				timedOut: job.timedOut,
				...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
				...(job.outputOutput === undefined ? {} : { outputOutput: job.outputOutput }),
			};
			return {
				content: [
					{
						type: "text",
						text:
							params.action === "logs"
								? JSON.stringify({ id: job.id, status: job.status, output: job.outputOutput })
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
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tui.frame(tool),
	);
}
export { Params as BashJobInput };
