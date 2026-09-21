import {
  addSessionMemoryTag,
  getEffectiveSessionMemoryMode,
  readSessionMemoryMeta,
  removeSessionMemoryTag,
  setNextSessionRetainMode,
  setSessionMemoryMode,
  setSessionRetainEnabled,
  type SessionMemoryMode,
} from "./session-memory-meta.js";

export async function readMemorySession(cwd: string, sessionFile?: string) {
  const meta = await readSessionMemoryMeta(cwd, sessionFile);
  return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}

export async function setMemorySessionMode(
  cwd: string,
  sessionFile: string | undefined,
  mode: SessionMemoryMode,
) {
  const meta = await setSessionMemoryMode(cwd, sessionFile, mode);
  return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}

export async function setMemorySessionRetain(
  cwd: string,
  sessionFile: string | undefined,
  enabled: boolean,
) {
  const meta = await setSessionRetainEnabled(cwd, sessionFile, enabled);
  return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}

export async function setNextMemoryRetainOff(cwd: string, sessionFile: string | undefined) {
  const meta = await setNextSessionRetainMode(cwd, sessionFile, "off");
  return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}

export async function addMemorySessionTag(
  cwd: string,
  sessionFile: string | undefined,
  tag: string,
) {
  const meta = await addSessionMemoryTag(cwd, sessionFile, tag);
  return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}

export async function removeMemorySessionTag(
  cwd: string,
  sessionFile: string | undefined,
  tag: string,
) {
  const meta = await removeSessionMemoryTag(cwd, sessionFile, tag);
  return { meta, effective: getEffectiveSessionMemoryMode(meta) };
}
