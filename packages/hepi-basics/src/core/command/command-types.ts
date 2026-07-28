import type { HepiCommandContext, HepiModule } from "../api/index.js";

export type { HepiCommandContext, HepiModule };

export interface HepiCommandRoute {
	readonly module: HepiModule;
	readonly args: string;
}

export interface ParsedHepiCommand {
	readonly subcommand: string;
	readonly args: string;
}
