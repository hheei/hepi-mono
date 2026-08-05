import { describe, expect, it } from "vitest";
import { formatReflectResult } from "../extensions/operations/reflect-presenter.js";

describe("formatReflectResult", () => {
  it("renders the markdown answer text", () => {
    expect(formatReflectResult({ text: "## Answer\nuse tabs" })).toBe("## Answer\nuse tabs");
  });

  it("renders structured output below the answer when present", () => {
    const rendered = formatReflectResult({
      text: "Done",
      structured_output: { answer: "tabs", confidence: 0.9 },
    });
    expect(rendered).toContain("Done");
    expect(rendered).toContain("Structured output:");
    expect(rendered).toContain('"answer": "tabs"');
  });

  it("summarizes a requested trace compactly instead of dumping raw JSON", () => {
    const rendered = formatReflectResult({
      text: "Answer",
      trace: {
        tool_calls: [{ tool: "recall" }, { tool: "expand" }, { tool: "recall" }],
        llm_calls: [{ scope: "final", duration_ms: 12 }],
      },
    });
    expect(rendered).toContain("Answer");
    expect(rendered).toContain("Trace: 3 tool calls (recall, expand); 1 LLM call");
    expect(rendered).not.toContain("duration_ms");
  });

  it("passes strings through and falls back to JSON for unexpected shapes", () => {
    expect(formatReflectResult("plain answer")).toBe("plain answer");
    expect(formatReflectResult({ unexpected: 1 })).toBe(JSON.stringify({ unexpected: 1 }, null, 2));
  });
});
