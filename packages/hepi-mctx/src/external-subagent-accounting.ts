import { openDatabase } from "@magic-context/core/features/magic-context/storage";
import type { SubagentInvocationStatus } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import { recordChildInvocation } from "@magic-context/core/features/magic-context/subagent-token-capture";

export type ExternalPiSubagentInvocation = {
    parentSessionId: string;
    type: string;
    startedAt: number;
    endedAt: number;
    status: SubagentInvocationStatus;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    providerId?: string;
    modelId?: string;
    error?: string;
};

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isStatus(value: unknown): value is SubagentInvocationStatus {
    return value === "completed" || value === "failed" || value === "aborted";
}

/**
 * Best-effort accounting for a Pi child agent owned by another extension.
 *
 * This deliberately records metadata only. Raw child output remains owned by
 * its caller and never enters Magic Context storage through this API.
 */
export function recordExternalPiSubagentInvocation(input: unknown): number | null {
    if (!input || typeof input !== "object") return null;
    const value = input as Record<string, unknown>;
    if (
        !isNonEmptyString(value.parentSessionId) ||
        !isNonEmptyString(value.type) ||
        !isFiniteNumber(value.startedAt) ||
        !isFiniteNumber(value.endedAt) ||
        !isStatus(value.status)
    ) {
        return null;
    }

    return recordChildInvocation({
        db: openDatabase(),
        parentSessionId: value.parentSessionId,
        harness: "pi",
        subagent: "pi_subagent",
        task: value.type,
        startedAt: value.startedAt,
        endedAt: value.endedAt,
        status: value.status,
        tokens: {
            input: isFiniteNumber(value.inputTokens) ? value.inputTokens : 0,
            output: isFiniteNumber(value.outputTokens) ? value.outputTokens : 0,
            cacheRead: isFiniteNumber(value.cacheReadTokens) ? value.cacheReadTokens : 0,
            cacheWrite: isFiniteNumber(value.cacheWriteTokens) ? value.cacheWriteTokens : 0,
        },
        providerId: isNonEmptyString(value.providerId) ? value.providerId : null,
        modelId: isNonEmptyString(value.modelId) ? value.modelId : null,
        error: isNonEmptyString(value.error) ? value.error : null,
    });
}
