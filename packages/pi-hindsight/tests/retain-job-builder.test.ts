import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import {
  buildRetainJob,
  type RetainJobBuildArgs,
} from "../extensions/lifecycle/retain-job-builder.js";

function retainJobArgs(overrides: Partial<RetainJobBuildArgs> = {}): RetainJobBuildArgs {
  return {
    config: DEFAULT_CONFIG,
    bankId: "bank",
    content: "safe content",
    context: "safe context",
    tags: ["source:pi"],
    documentId: "pi-session:test",
    updateMode: "append",
    ...overrides,
  };
}

describe("retain job builder redaction", () => {
  it("redacts content and context when secret redaction is enabled", () => {
    const job = buildRetainJob(
      retainJobArgs({
        content: "content API_KEY=content-secret",
        context: "context https://example.test/callback?token=context-secret&ok=true",
      }),
    );

    expect(job.item.content).toContain("API_KEY=[REDACTED]");
    expect(job.item.content).not.toContain("content-secret");
    expect(job.item.context).toContain("token=[REDACTED]");
    expect(job.item.context).not.toContain("context-secret");
  });

  it("preserves unredacted context when secret redaction is disabled", () => {
    const job = buildRetainJob(
      retainJobArgs({
        config: {
          ...DEFAULT_CONFIG,
          retain: { ...DEFAULT_CONFIG.retain, redactSecrets: false },
        },
        content: "content API_KEY=content-secret",
        context: "context API_KEY=context-secret",
      }),
    );

    expect(job.item.content).toContain("API_KEY=content-secret");
    expect(job.item.context).toContain("API_KEY=context-secret");
  });

  it("keeps metadata redaction intact", () => {
    const job = buildRetainJob(
      retainJobArgs({
        metadata: {
          source_url: "https://example.test/callback?token=metadata-secret&ok=true",
          api_key: "sk-abcdefghijklmnopqrstuvwxyz",
        },
      }),
    );

    expect(job.item.metadata).toMatchObject({
      source_url: "https://example.test/callback?token=[REDACTED]",
      api_key: "[REDACTED_API_KEY]",
    });
    expect(JSON.stringify(job.item.metadata)).not.toContain("metadata-secret");
    expect(JSON.stringify(job.item.metadata)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
