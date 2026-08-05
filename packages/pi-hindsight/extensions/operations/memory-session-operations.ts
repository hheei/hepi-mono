import {
  addMemorySessionTag,
  readMemorySession,
  removeMemorySessionTag,
  setMemorySessionMode,
  setMemorySessionRetain,
  setNextMemoryRetainOff,
} from "../utils/session-operations.js";
import type { SessionMemoryMode } from "../utils/session-memory-meta.js";

export function createSessionOperations() {
  return {
    async session(cwd: string, sessionFile?: string) {
      return readMemorySession(cwd, sessionFile);
    },

    async setSessionMode(cwd: string, sessionFile: string | undefined, mode: SessionMemoryMode) {
      return setMemorySessionMode(cwd, sessionFile, mode);
    },

    async setSessionRetain(cwd: string, sessionFile: string | undefined, enabled: boolean) {
      return setMemorySessionRetain(cwd, sessionFile, enabled);
    },

    async setNextRetainOff(cwd: string, sessionFile: string | undefined) {
      return setNextMemoryRetainOff(cwd, sessionFile);
    },

    async addSessionTag(cwd: string, sessionFile: string | undefined, tag: string) {
      return addMemorySessionTag(cwd, sessionFile, tag);
    },

    async removeSessionTag(cwd: string, sessionFile: string | undefined, tag: string) {
      return removeMemorySessionTag(cwd, sessionFile, tag);
    },
  };
}
