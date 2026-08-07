import type { ProjectConfigPatchInput } from "../config/config-writer.js";
import type { InitHealth } from "../lifecycle/memory-lifecycle.js";
import type { HindsightLikeClient, ResolvedConfig } from "../types.js";

export interface MemoryOperationsDeps {
	getClient(): HindsightLikeClient;
	getConfig(): ResolvedConfig;
	getProjectBankId(): string;
	getInitHealth?(): InitHealth | undefined;
	reloadConfig?(cwd: string): void;
}

export type ConfigureMemoryArgs = ProjectConfigPatchInput;
