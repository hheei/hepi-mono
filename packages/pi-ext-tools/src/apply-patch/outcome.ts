export type PatchHunkOutcome =
	| {
			readonly kind: "applied";
			readonly hunkIndex: number;
			readonly startLine: number;
			readonly length: number;
			readonly match: "exact" | "fuzzy";
	  }
	| { readonly kind: "context_not_found"; readonly hunkIndex: number }
	| {
			readonly kind: "ambiguous_exact";
			readonly hunkIndex: number;
			readonly candidateStartLines: readonly number[];
	  };

export type AppliedPatchHunk = Extract<PatchHunkOutcome, { readonly kind: "applied" }>;
export type RejectedPatchHunk = Exclude<PatchHunkOutcome, { readonly kind: "applied" }>;

export interface ApplyPatchHunkSnapshot {
	readonly path: string;
	readonly hunkIndex: number;
	readonly startLine: number;
	readonly afterStartLine: number;
	readonly before: readonly string[];
	readonly after: readonly string[];
}

export interface PreparedPatchUpdate {
	readonly after: Uint8Array;
	readonly mode: "exact" | "fuzzy" | undefined;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly outcomes: readonly AppliedPatchHunk[];
	readonly rejected: readonly RejectedPatchHunk[];
	readonly snapshots: readonly ApplyPatchHunkSnapshot[];
}

export interface ApplyPatchAppliedOperation {
	readonly operationIndex: number;
	readonly kind: "add" | "delete" | "update";
	readonly paths: readonly string[];
	readonly outcomes: readonly AppliedPatchHunk[];
	readonly snapshots: readonly ApplyPatchHunkSnapshot[];
}

export interface ApplyPatchRejection {
	readonly operationIndices: readonly number[];
	readonly paths: readonly string[];
	readonly error: string;
	readonly diagnostics: readonly RejectedPatchHunk[];
}

export type ApplyPatchProgressStage = "parsed" | "publishing" | "done";

export type ApplyPatchOperationStatus =
	| "pending"
	| "applied"
	| "partial"
	| "fuzzy"
	| "rejected"
	| "unconfirmed"
	| "not_applied";

export type ApplyPatchOperationProgress = {
	readonly operationIndex: number;
	readonly kind: "add" | "delete" | "update";
	readonly path: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly status: ApplyPatchOperationStatus;
	readonly appliedHunks?: number;
	readonly totalHunks?: number;
	readonly partialReason?: string;
};

export interface ApplyPatchProgress {
	readonly stage: ApplyPatchProgressStage;
	readonly files: number;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly operations: readonly ApplyPatchOperationProgress[];
}

export interface ApplyPatchInWorkspaceResult {
	readonly changedPaths: readonly string[];
	readonly addedLines: number;
	readonly removedLines: number;
	readonly operations: readonly ApplyPatchOperationProgress[];
	readonly operationCount: number;
	readonly exactUpdateCount: number;
	readonly fuzzyUpdateCount: number;
	readonly applied: readonly ApplyPatchAppliedOperation[];
	readonly rejected: readonly ApplyPatchRejection[];
	readonly unconfirmed: readonly ApplyPatchRejection[];
	readonly notApplied: readonly ApplyPatchRejection[];
}
