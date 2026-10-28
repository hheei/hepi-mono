import { readFile } from "node:fs/promises";

export const TASK_CARD_URI = "ui://hheei/subagents/task";
export const DASHBOARD_URI = "ui://hheei/subagents/dashboard";
export const APP_MIME = "text/html;profile=mcp-app";

let template: Promise<string> | undefined;

/** Static MCP Apps page. `{{VIEW}}` is `task` or `dashboard`; the file ships beside this module in dist. */
export async function readAppHtml(kind: "task" | "dashboard"): Promise<string> {
	template ??= readFile(new URL("./app.html", import.meta.url), "utf8");
	const html = await template;
	const title = kind === "task" ? "Subagent" : "Subagents";
	return html.replaceAll("{{VIEW}}", kind).replaceAll("{{TITLE}}", title);
}
