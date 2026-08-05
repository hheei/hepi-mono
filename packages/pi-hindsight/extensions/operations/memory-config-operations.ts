import type { ConfigureMemoryArgs, MemoryOperationsDeps } from "./memory-operation-types.js";
import { configureMemory, initMemoryConfig } from "../config/config-writer.js";

export function createConfigOperations(deps: MemoryOperationsDeps) {
  return {
    async configure(cwd: string, args: ConfigureMemoryArgs) {
      return configureMemory(cwd, args, deps);
    },

    async init(cwd: string) {
      const result = await initMemoryConfig(cwd, deps);
      deps.reloadConfig?.(cwd);
      return result;
    },
  };
}
