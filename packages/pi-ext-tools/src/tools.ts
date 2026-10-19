import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashToolOptions, registerBashTool } from "./bash.js";
import { registerEditTool } from "./edit.js";
import { registerFindTool } from "./find.js";
import { registerGrepTool } from "./grep.js";
import { registerReadTool } from "./read.js";
import { registerWriteTool } from "./write.js";

/** Registers the file and foreground Bash tool catalog; live settings stay caller-owned. */
export function registerTools(pi: ExtensionAPI, bashOptions?: BashToolOptions): void {
	registerReadTool(pi);
	registerGrepTool(pi);
	registerFindTool(pi);
	registerEditTool(pi);
	registerWriteTool(pi);
	registerBashTool(pi, bashOptions);
}
