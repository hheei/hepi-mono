import { randomUUID } from "node:crypto";
import type {
  HindsightObservationScopes,
  ResolvedConfig,
  RetainJob,
  UpdateMode,
} from "../types.js";
import { redactSecrets } from "../utils/sanitize.js";

export interface RetainJobBuildArgs {
  config: ResolvedConfig;
  bankId: string;
  content: string;
  context: string;
  tags: string[];
  documentId: string;
  updateMode: UpdateMode;
  metadata?: Record<string, string>;
  timestamp?: string;
  observationScopes?: HindsightObservationScopes;
  documentTags?: string[];
  entities?: RetainJob["item"]["entities"];
  async?: boolean;
}

function sanitizedMetadata(
  metadata: Record<string, string> | undefined,
  redact: boolean,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  if (!redact) return metadata;
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, redactSecrets(value)]),
  );
}

export function buildRetainJob(args: RetainJobBuildArgs): RetainJob {
  const redact = args.config.retain.redactSecrets;
  const content = redact ? redactSecrets(args.content) : args.content;
  const context = redact ? redactSecrets(args.context) : args.context;
  const metadata = sanitizedMetadata(args.metadata, redact);
  return {
    id: randomUUID(),
    bankId: args.bankId,
    createdAt: new Date().toISOString(),
    documentId: args.documentId,
    updateMode: args.updateMode,
    item: {
      content,
      context,
      timestamp: args.timestamp ?? new Date().toISOString(),
      async: args.async ?? args.config.retain.async,
      ...((args.entities?.length ?? args.config.retain.entities.length)
        ? { entities: [...args.config.retain.entities, ...(args.entities ?? [])] }
        : {}),
      tags: args.tags,
      ...(metadata ? { metadata } : {}),
      ...(args.observationScopes?.length ? { observationScopes: args.observationScopes } : {}),
      ...(args.documentTags?.length ? { documentTags: args.documentTags } : {}),
    },
    retries: 0,
  };
}
