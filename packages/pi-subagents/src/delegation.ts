import type { PublicSubagent, SubagentState } from "./domain.js";
import type { Receipt, ReceiptStatus } from "./receipts.js";

/** What the agent's runtime is doing now, kept apart from the selected delegation's status. */
export interface DelegationProgress {
	readonly runtimeState: SubagentState;
	readonly summary?: string;
	readonly activeTool?: string;
}

/** Why a delegation did not produce a result, with what it may already have done. */
export interface DelegationError {
	readonly reason: string;
	readonly safeToRetry: boolean;
	readonly sideEffects: readonly string[];
}

/**
 * Public identity of one delegation: the agent session id plus its monotonic revision. Internal
 * database keys never appear here, so both consumers speak the same vocabulary.
 */
export interface DelegationView {
	readonly id: string;
	readonly revision: number;
	readonly status: ReceiptStatus;
	readonly task: string;
	readonly hasOutput: boolean;
	readonly agent?: string;
	readonly cwd?: string;
	readonly resultText?: string;
	readonly progress?: DelegationProgress;
	readonly error?: DelegationError;
}

/**
 * Projects one stored delegation. A result only exists for a completed or blocked delegation: the
 * text of a failed or uncertain one is the reason it failed, not child output.
 */
export function delegationView(
	receipt: Receipt,
	child?: PublicSubagent,
	options?: { readonly includeOutput?: boolean },
): DelegationView {
	if (receipt.childId === undefined || receipt.revision === undefined) {
		throw new Error(`Delegation ${receipt.delegationId} has no public identity`);
	}
	const failed = receipt.status === "failed" || receipt.status === "uncertain";
	const text = receipt.resultText;
	const hasOutput = text !== undefined && !failed;
	return {
		id: receipt.childId,
		revision: receipt.revision,
		status: receipt.status,
		task: receipt.task,
		hasOutput,
		...(options?.includeOutput === true && text !== undefined && hasOutput
			? { resultText: text }
			: {}),
		...(failed && text !== undefined
			? { error: { reason: text, safeToRetry: false, sideEffects: [] } }
			: {}),
		...(child === undefined
			? {}
			: {
					agent: child.agent,
					cwd: child.cwd,
					progress: {
						runtimeState: child.state,
						...(child.summary === undefined ? {} : { summary: child.summary }),
						...(child.activeTool === undefined ? {} : { activeTool: child.activeTool }),
					},
				}),
	};
}
