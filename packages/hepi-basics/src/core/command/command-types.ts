import type { HepiCommandContext, HepiModule } from "../api/index.js";

export type { HepiCommandContext, HepiModule };

export interface HepiCommandRegistration {
	readonly name: string;
	readonly description: string;
	readonly handler: (args: string, ctx: HepiCommandContext) => void | Promise<void>;
}

export interface HepiCommandRoute {
	readonly module: HepiModule;
	readonly args: string;
}

export interface ParsedHepiCommand {
	readonly subcommand: string;
	readonly args: string;
}
