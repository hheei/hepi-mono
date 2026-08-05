import { describe, expect, it } from "vitest";
import {
  flushRetainQueueNotifyLevel,
  formatFlushRetainQueueResult,
  formatRetainOutcome,
} from "../extensions/queue/flush-presenter.js";
import type { FlushRetainQueueResult } from "../extensions/queue/queue.js";

function result(overrides: Partial<FlushRetainQueueResult> = {}): FlushRetainQueueResult {
  return { sent: 1, remaining: 0, deadLettered: 0, malformed: 0, ...overrides };
}

describe("flush presenter", () => {
  it("formats retain queue flush results", () => {
    expect(formatFlushRetainQueueResult(result({ sent: 2, deadLettered: 1, remaining: 3 }))).toBe(
      "Hindsight flushed 2; dead-lettered 1; remaining 3",
    );
  });

  it("appends retain outcome aggregates when present", () => {
    expect(
      formatFlushRetainQueueResult(
        result({ sent: 2, outcome: { itemsCount: 5, operations: 2, tokens: 300 } }),
      ),
    ).toBe(
      "Hindsight flushed 2; dead-lettered 0; remaining 0; retained 5 items, 2 operations, 300 tokens",
    );
    expect(formatRetainOutcome(undefined)).toBe("");
    expect(formatRetainOutcome({ operations: 1 })).toBe("1 operations");
  });

  it("warns when a flush leaves queued or dead-lettered jobs", () => {
    expect(flushRetainQueueNotifyLevel(result())).toBe("info");
    expect(flushRetainQueueNotifyLevel(result({ remaining: 1 }))).toBe("warning");
    expect(flushRetainQueueNotifyLevel(result({ deadLettered: 1 }))).toBe("warning");
  });

  it("warns on malformed-only results", () => {
    expect(flushRetainQueueNotifyLevel(result({ sent: 0 }))).toBe("info");
    expect(flushRetainQueueNotifyLevel(result({ sent: 0, malformed: 5 }))).toBe("warning");
    expect(flushRetainQueueNotifyLevel(result({ sent: 1, malformed: 3 }))).toBe("warning");
  });

  it("formats edge case results correctly", () => {
    expect(formatFlushRetainQueueResult(result({ sent: 0, remaining: 0, deadLettered: 0 }))).toBe(
      "Hindsight flushed 0; dead-lettered 0; remaining 0",
    );
    expect(
      formatFlushRetainQueueResult(result({ sent: 100, remaining: 50, deadLettered: 25 })),
    ).toBe("Hindsight flushed 100; dead-lettered 25; remaining 50");
  });
});
