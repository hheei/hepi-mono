import type { HePiCommandContext, HePiModule } from "../api/index.js";

export type { HePiCommandContext, HePiModule };

export interface HePiCommandRegistration {
	readonly name: string;
	readonly description: string;
	readonly handler: (args: string, ctx: HePiCommandContext) => void | Promise<void>;
}

export interface HePiCommandRoute {
	readonly module: HePiModule;
	readonly args: string;
}

export interface ParsedHePiCommand {
	readonly subcommand: string;
	readonly args: string;
}
