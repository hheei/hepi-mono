import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { splitSubcommand, subcommandCompletions } from "@hheei/pi-ext-core";
import type { PublicSubagent } from "./domain.js";
import type { SubagentManager } from "./manager.js";

const STATUS_KEY = "pi-subagents";
/** Verbs of the dispatcher below; the completer and the no-argument picker share them. */
const SUBAGENT_SUBCOMMANDS = ["list", "inspect", "attach", "send", "stop"] as const;
const SUBAGENT_COMMAND_USAGE = "Usage: /subagents list|inspect|attach [id]|send|stop [id]";

export function formatStatusLine(children: readonly PublicSubagent[]): string | undefined {
	const visible = children.filter((child) => child.state !== "done" && child.state !== "stopped");
	if (visible.length === 0) return undefined;
	return visible
		.map((child) => {
			const name = child.displayName ?? child.agent;
			const mode = child.mode === "tui" ? "tui" : child.state;
			const flag = child.interrupted !== undefined ? " interrupted" : "";
			return `${name} ${mode}${flag}`;
		})
		.join(" · ");
}

function notifyResult(
	ctx: ExtensionContext,
	result: { readonly reason: string } | object,
	ok: string,
): void {
	if ("reason" in result && typeof result.reason === "string") {
		ctx.ui.notify(result.reason, "error");
		return;
	}
	ctx.ui.notify(ok);
}

function childLabel(child: PublicSubagent): string {
	const name = child.displayName ?? child.agent;
	return `${name} ${child.id} ${child.state}/${child.mode}`;
}

async function pickChild(
	ctx: ExtensionCommandContext,
	children: readonly PublicSubagent[],
	title: string,
): Promise<PublicSubagent | undefined> {
	if (children.length === 0) {
		ctx.ui.notify("No matching subagents", "warning");
		return undefined;
	}
	if (children.length === 1) return children[0];
	const labels = children.map(childLabel);
	const selected = await ctx.ui.select(title, labels);
	if (selected === undefined) return undefined;
	return children[labels.indexOf(selected)];
}

async function attachSelected(
	ctx: ExtensionCommandContext,
	manager: SubagentManager,
	id?: string,
): Promise<void> {
	if (id !== undefined && id !== "") {
		notifyResult(ctx, await manager.attach(id), `Attached ${id}`);
		return;
	}
	const idle = (await manager.list()).filter(
		(child) => child.mode === "rpc" && child.state === "idle",
	);
	const child = await pickChild(ctx, idle, "Attach idle subagent");
	if (child === undefined) return;
	notifyResult(ctx, await manager.attach(child.id), `Attached ${child.id}`);
}

async function stopSelected(
	ctx: ExtensionCommandContext,
	manager: SubagentManager,
	id?: string,
): Promise<void> {
	if (id !== undefined && id !== "") {
		notifyResult(ctx, await manager.stop(id), `Stopped ${id}`);
		return;
	}
	const live = (await manager.list()).filter(
		(child) => child.state !== "done" && child.state !== "stopped",
	);
	const child = await pickChild(ctx, live, "Stop subagent");
	if (child === undefined) return;
	notifyResult(ctx, await manager.stop(child.id), `Stopped ${child.id}`);
}

export function registerParentCommands(pi: ExtensionAPI, manager: SubagentManager): void {
	pi.registerCommand("subagents", {
		description: "Manage subagents: /subagents [list | inspect | attach [id] | send | stop [id]]",
		getArgumentCompletions: subcommandCompletions(SUBAGENT_SUBCOMMANDS),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"Use spawn_subagent / send_subagent / get_subagent / stop_subagent in this mode",
				);
				return;
			}
			const { verb, rest: target } = splitSubcommand(args);
			// Only `attach` and `stop` take a subagent id; the picker verbs ignore the rest.
			const action =
				verb === "" ? await ctx.ui.select("Subagents", [...SUBAGENT_SUBCOMMANDS]) : verb;
			if (action === undefined) return;
			const children = await manager.list();
			if (action === "list") {
				if (children.length === 0) {
					ctx.ui.notify("No subagents", "warning");
					return;
				}
				ctx.ui.notify(children.map(childLabel).join("\n"));
				return;
			}
			if (action === "inspect") {
				const child = await pickChild(ctx, children, "Inspect subagent");
				if (child === undefined) return;
				const inspected = await manager.get(child.id);
				if ("reason" in inspected) {
					ctx.ui.notify(inspected.reason, "error");
					return;
				}
				ctx.ui.notify(
					`${childLabel(inspected)}\n${inspected.summary ?? "no summary"}\nmodel ${inspected.model.provider}/${inspected.model.id}`,
				);
				return;
			}
			if (action === "attach") {
				await attachSelected(ctx, manager, target);
				return;
			}
			if (action === "stop") {
				await stopSelected(ctx, manager, target);
				return;
			}
			if (action === "send") {
				const live = children.filter(
					(child) => child.mode === "rpc" && (child.state === "idle" || child.state === "running"),
				);
				const child = await pickChild(ctx, live, "Send to subagent");
				if (child === undefined) return;
				const message = await ctx.ui.input("Message for subagent");
				if (message === undefined || message.trim() === "") return;
				notifyResult(ctx, await manager.send(child.id, message.trim()), `Sent to ${child.id}`);
				return;
			}

			ctx.ui.notify(`Unknown subcommand "${action}". ${SUBAGENT_COMMAND_USAGE}`, "warning");
		},
	});
	pi.registerShortcut("ctrl+shift+a", {
		description: "Attach idle subagent",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			return attachSelected(ctx as ExtensionCommandContext, manager);
		},
	});
	pi.registerShortcut("ctrl+shift+s", {
		description: "Stop subagent",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			return stopSelected(ctx as ExtensionCommandContext, manager);
		},
	});
}

export function bindParentStatus(
	_pi: ExtensionAPI,
	context: ExtensionContext,
	manager: SubagentManager,
	signal?: AbortSignal,
): () => void {
	let disposed = false;
	const refresh = (): void => {
		if (disposed || signal?.aborted) return;
		void manager
			.list()
			.then((children) => {
				if (disposed || signal?.aborted) return;
				try {
					context.ui.setStatus(STATUS_KEY, formatStatusLine(children));
				} catch {
					// Context may be stale after session replacement or reload.
				}
			})
			.catch(() => {});
	};
	const unsubscribe = manager.onChange(refresh);
	refresh();
	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		if (signal?.aborted) return;
		try {
			context.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Context may be stale after session replacement or reload.
		}
	};
}
