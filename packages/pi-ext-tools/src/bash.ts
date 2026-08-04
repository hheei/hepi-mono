import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	type BashToolDetails,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getToolResultLayout, registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { SelectableBashResult } from "./selectable-bash-result.js";

const OWNER = "@hheei/pi-ext-tools";
const DefaultInput = Type.Object(
	{ command: Type.String(), timeout: Type.Optional(Type.Number()) },
	{ additionalProperties: false },
);
const AsyncInput = Type.Object(
	{
		command: Type.String(),
		timeout: Type.Optional(Type.Number()),
		async: Type.Literal(true),
		pty: Type.Optional(Type.Literal(false)),
	},
	{ additionalProperties: false },
);
const BashInput = Type.Union([DefaultInput, AsyncInput]);
type Input = Static<typeof BashInput>;

function result(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

/** Pi original definition remains default execution; async is extension-owned and session-scoped. */
export function registerBashTool(pi: ExtensionAPI, state?: FffRuntimeState): void {
	const template = createBashToolDefinition(process.cwd());
	const components = new WeakMap<object, SelectableBashResult>();
	const upstreamComponents = new WeakMap<object, import("@earendil-works/pi-tui").Component>();
	const tool = {
		...template,
		parameters: BashInput,
		renderResult: (
			r: AgentToolResult<BashToolDetails | undefined>,
			options: Parameters<NonNullable<typeof template.renderResult>>[1],
			theme: Parameters<NonNullable<typeof template.renderResult>>[2],
			context: Parameters<NonNullable<typeof template.renderResult>>[3],
		) => {
			const previous = upstreamComponents.get(context.state);
			const upstream = template.renderResult?.(r, options, theme, {
				...context,
				lastComponent: previous,
			});
			if (upstream === undefined) throw new Error("Pi bash renderer unavailable");
			upstreamComponents.set(context.state, upstream);
			const layout = getToolResultLayout(context);
			if (!options.expanded || layout === undefined) {
				components.get(context.state)?.dispose();
				return upstream;
			}
			const component = components.get(context.state) ?? new SelectableBashResult();
			components.set(context.state, component);
			const output = r.content
				.filter((part) => part.type === "text")
				.map((part) => ("text" in part ? part.text : ""))
				.join("\n")
				.trim();
			component.set(upstream, output, theme, layout);
			return component;
		},
		async execute(
			id: string,
			params: Input,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			context: ExtensionContext,
		) {
			if ("async" in params && params.async === true) {
				const jobs = state?.getBashJobs();
				if (jobs === undefined)
					return result("Async Bash unavailable outside active session", {
						error: "session_unavailable",
					});
				try {
					const job = jobs.start(
						params.command,
						context.cwd,
						state?.getSettings().shellPath,
						params.timeout === undefined ? undefined : Math.max(0, params.timeout * 1000),
					);
					return result(`Started Bash job ${job.id}`, { ...job, output: undefined });
				} catch (error) {
					return result(
						`Unable to start Bash job: ${error instanceof Error ? error.message : String(error)}`,
						{ error: "start_failed" },
					);
				}
			}
			const originalParams = {
				command: params.command,
				...(params.timeout === undefined ? {} : { timeout: params.timeout }),
			};
			return createBashToolDefinition(context.cwd).execute(
				id,
				originalParams,
				signal,
				onUpdate,
				context,
			);
		},
	} as unknown as ToolDefinition<typeof BashInput, unknown, unknown>;
	registerManagedLoadoutTool(
		pi,
		{
			id: "bash",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}

export { BashInput };
