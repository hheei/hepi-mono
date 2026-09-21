import { constants } from "node:fs";
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";

const RECALL_BLOCK_START = "<hindsight-memory>";

export interface RecallTranscriptScanResult {
  sessionFile: string;
  lineCount: number;
  matchingLines: number[];
  hasMatches: boolean;
}

export interface RecallTranscriptPruneResult extends RecallTranscriptScanResult {
  pruned: number;
  backupPath: string;
}

function lineContainsRecallBlock(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    const message = (parsed as { message?: { content?: unknown }; content?: unknown }).message;
    const content = message?.content ?? (parsed as { content?: unknown }).content;
    return typeof content === "string" && content.trim().startsWith(RECALL_BLOCK_START);
  } catch {
    return false;
  }
}

function uniqueBackupPath(sessionFile: string): string {
  return `${sessionFile}.hindsight-recall-prune.${Date.now()}.bak`;
}

export async function scanTranscriptForRecallBlocks(
  sessionFile: string,
): Promise<RecallTranscriptScanResult> {
  const text = await readFile(sessionFile, "utf8");
  const lines = text.split("\n");
  const contentLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
  const matchingLines = contentLines
    .map((line, index) => (lineContainsRecallBlock(line) ? index + 1 : 0))
    .filter((lineNumber) => lineNumber > 0);
  return {
    sessionFile,
    lineCount: contentLines.length,
    matchingLines,
    hasMatches: matchingLines.length > 0,
  };
}

export async function pruneTranscriptRecallBlocks(
  sessionFile: string,
): Promise<RecallTranscriptPruneResult> {
  const before = await stat(sessionFile);
  const text = await readFile(sessionFile, "utf8");
  const hasTrailingNewline = text.endsWith("\n");
  const lines = hasTrailingNewline ? text.slice(0, -1).split("\n") : text.split("\n");
  const matchingLines: number[] = [];
  const kept = lines.filter((line, index) => {
    const remove = lineContainsRecallBlock(line);
    if (remove) matchingLines.push(index + 1);
    return !remove;
  });
  const afterRead = await stat(sessionFile);
  if (before.mtimeMs !== afterRead.mtimeMs || before.size !== afterRead.size) {
    throw new Error(
      "Session file changed during recall cleanup scan; retry when transcript is idle.",
    );
  }
  const backupPath = uniqueBackupPath(sessionFile);
  await copyFile(sessionFile, backupPath, constants.COPYFILE_EXCL);
  const tmp = `${sessionFile}.hindsight-prune.tmp`;
  await writeFile(tmp, `${kept.join("\n")}${hasTrailingNewline ? "\n" : ""}`, "utf8");
  await rename(tmp, sessionFile);
  return {
    sessionFile,
    lineCount: lines.length,
    matchingLines,
    hasMatches: matchingLines.length > 0,
    pruned: matchingLines.length,
    backupPath,
  };
}
