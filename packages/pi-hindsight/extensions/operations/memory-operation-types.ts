import type { HindsightLikeClient, ResolvedConfig } from "../types.js";
import type { ProjectConfigPatchInput } from "../config/config-writer.js";
import type { InitHealth } from "../lifecycle/memory-lifecycle.js";

export interface MemoryOperationsDeps {
  getClient(): HindsightLikeClient;
  getConfig(): ResolvedConfig;
  getProjectBankId(): string;
  getInitHealth?(): InitHealth | undefined;
  reloadConfig?(cwd: string): void;
}

export type ConfigureMemoryArgs = ProjectConfigPatchInput;
