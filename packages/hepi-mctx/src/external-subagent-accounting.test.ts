import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "@magic-context/core/features/magic-context/storage";
import { getSubagentInvocations } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import { recordExternalPiSubagentInvocation } from "./external-subagent-accounting";

let previousDataHome: string | undefined;
let tempHome: string;

beforeEach(() => {
    previousDataHome = process.env.XDG_DATA_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "mc-external-subagent-"));
    process.env.XDG_DATA_HOME = tempHome;
    mkdirSync(join(tempHome, "cortexkit", "magic-context"), { recursive: true });
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    rmSync(tempHome, { recursive: true, force: true });
});

describe("external Pi subagent accounting", () => {
    test("records metadata without a child result", () => {
        const invocationId = recordExternalPiSubagentInvocation({
            parentSessionId: "parent-session",
            type: "explorer",
            startedAt: 1,
            endedAt: 2,
            status: "completed",
            inputTokens: 11,
            outputTokens: 3,
        });

        expect(invocationId).not.toBeNull();
        const invocations = getSubagentInvocations(openDatabase(), "parent-session");
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toMatchObject({
            harness: "pi",
            subagent: "pi_subagent",
            task: "explorer",
            status: "completed",
            inputTokens: 11,
            outputTokens: 3,
        });
    });

    test("rejects malformed input without opening storage", () => {
        expect(recordExternalPiSubagentInvocation({ type: "explorer" })).toBeNull();
    });
});
