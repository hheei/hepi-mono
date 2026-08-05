import { describe, expect, it } from "vitest";
import {
  expandObservationScopes,
  observationScopePlaceholders,
} from "../extensions/lifecycle/observation-scopes.js";

const identity = {
  cwd: "/repo/project",
  repoKey: "abc123",
  projectId: "github-com-luxus-demo",
  sessionId: "session-1",
  projectBankId: "pi-project-abc123",
};

describe("observation scopes", () => {
  it("expands supported placeholders deterministically", () => {
    expect(
      expandObservationScopes(
        [
          ["harness:pi"],
          ["project:{projectId}"],
          ["repo:{repoKey}"],
          ["bank:{projectBankId}", "target:{bankId}", "session:{sessionId}", "cwd:{cwdHash}"],
        ],
        identity,
      ),
    ).toEqual([
      ["harness:pi"],
      ["project:github-com-luxus-demo"],
      ["repo:abc123"],
      [
        "bank:pi-project-abc123",
        "target:pi-project-abc123",
        "session:session-1",
        `cwd:${observationScopePlaceholders(identity).cwdHash}`,
      ],
    ]);
  });

  it("deduplicates identical expanded scopes", () => {
    expect(expandObservationScopes([["repo:{repoKey}"], ["repo:abc123"]], identity)).toEqual([
      ["repo:abc123"],
    ]);
  });

  it("rejects unknown placeholders", () => {
    expect(() => expandObservationScopes([["user:{userId}"]], identity)).toThrow(
      /Unknown observation scope placeholder/,
    );
  });

  it("rejects empty scopes and values", () => {
    expect(() => expandObservationScopes([], identity)).not.toThrow();
    expect(() => expandObservationScopes([[]], identity)).toThrow(/must not be empty/);
    expect(() => expandObservationScopes([["   "]], identity)).toThrow(/must not be empty/);
  });
});
