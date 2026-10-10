import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	isTerminalTaskStatus,
	provideService,
	TASK_REGISTRY_SERVICE_KEY,
	TaskRegistry,
	textToolResult,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { backgroundBashRenderers } from "./background-presentation.js";
import type { BashJobRegistry } from "./bash-jobs.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { startTaskDelivery } from "./task-delivery.js";

export const TASK_TOOL_IDS: readonly string[] = ["bg_bash_get", "bg_bash_stop"];

export function startTaskControl(
	context: ExtensionLifecycleContext,
	jobs?: BashJobRegistry,
): TaskRegistry {
	const registry = new TaskRegistry();
	const stopDelivery = startTaskDelivery({
		pi: context.pi,
		registry,
		...(jobs === undefined ? {} : { jobs }),
		session: context.extension,
		signal: context.signal,
		notify: (message, level) => context.extension.ui.notify(message, level),
	});
	if (!provideService(context, TASK_REGISTRY_SERVICE_KEY, registry)) {
		stopDelivery();
		registry.dispose();
		throw new Error("Another extension already provides the task registry service");
	}
	context.resources.add("task-control", () => {
		stopDelivery();
		registry.dispose();
	});
	return registry;
}

const IdParams = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description: "Background Bash task ID returned by bg_bash_spawn.",
		}),
	},
	{ additionalProperties: false },
);
const GetParams = Type.Object(
	{
		id: IdParams.properties.id,
		keys: Type.Optional(
			Type.String({
				description:
					"Comma-separated fields: status, progress, diagnostic. Defaults to status,progress.",
			}),
		),
	},
	{ additionalProperties: false },
);

export function registerTaskTools(pi: ExtensionAPI, state: FffRuntimeState): void {
	const getTask = (id: string) => {
		const tasks = state.getTasks();
		if (tasks === undefined) throw new Error("No active background Bash session");
		const task = tasks.get(id);
		if (task === undefined || task.type !== "bash")
			throw new Error(`Background Bash task ${id} not found`);
		return { tasks, task };
	};
	const get: ToolDefinition<typeof GetParams> = {
		name: "bg_bash_get",
		...backgroundBashRenderers(pi, "bg_bash_get"),
		label: "Get background Bash",
		namespace: { name: "bg_bash", description: "Background Bash commands" },
		description:
			"Inspect background Bash runtime status, progress, or diagnostic details. Results return automatically; do not poll for completion. Related tools: bg_bash_spawn, bg_bash_stop.",
		parameters: GetParams,
		exposure: "deferred",
		defaultActive: false,
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(_id, params) {
			const keys = [
				...new Set(
					(params.keys ?? "status,progress")
						.split(",")
						.map((key) => key.trim())
						.filter(Boolean),
				),
			];
			for (const key of keys) {
				if (key !== "status" && key !== "progress" && key !== "diagnostic")
					throw new Error(
						`Unknown bg_bash_get key "${key}". Allowed keys: status, progress, diagnostic.`,
					);
			}
			if (keys.length === 0) keys.push("status", "progress");
			const { task } = getTask(params.id);
			const job = state.getBashJobs()?.get(params.id);
			const path = job?.logPath;
			const view: Record<string, unknown> = {};
			if (keys.includes("status")) view.status = task.status;
			if (keys.includes("progress")) {
				view.progress = {
					command: job?.command.slice(0, 200) ?? task.purpose,
					...(job === undefined
						? {}
						: {
								cwd: job.cwd,
								elapsedSeconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
							}),
					...(path === undefined ? {} : { path }),
					...(!isTerminalTaskStatus(task.status) && job?.status === "running"
						? {
								output: job.output.slice(-10_000),
								truncated: job.truncated || job.output.length > 10_000,
							}
						: {}),
				};
			}
			if (keys.includes("diagnostic")) {
				const diagnostic = job?.timedOut
					? "Command timed out"
					: (job?.diagnostic ??
						(job?.status === "failed" && job.exitCode !== null
							? `Command exited with code ${job.exitCode}`
							: undefined));
				if (diagnostic !== undefined) view.diagnostic = diagnostic.slice(0, 2000);
			}
			return textToolResult(JSON.stringify(view), view);
		},
	};
	const stop: ToolDefinition<typeof IdParams> = {
		name: "bg_bash_stop",
		...backgroundBashRenderers(pi, "bg_bash_stop"),
		label: "Stop background Bash",
		namespace: { name: "bg_bash", description: "Background Bash commands" },
		description:
			"Stop one background Bash process tree by ID. Terminal result returns automatically. Related tools: bg_bash_spawn, bg_bash_get.",
		parameters: IdParams,
		exposure: "deferred",
		defaultActive: false,
		annotations: { destructiveHint: true },
		async execute(_id, params) {
			const { tasks } = getTask(params.id);
			const outcomes = tasks.stop([params.id]);
			if (outcomes.some((outcome) => outcome.status === "stop_failed"))
				throw new Error("Unable to stop background Bash task.");
			return textToolResult(
				outcomes.some((outcome) => outcome.status === "already_terminal")
					? "Task already finished."
					: "Stop requested.",
				undefined,
			);
		},
	};
	pi.registerTool(get);
	pi.registerTool(stop);
}
