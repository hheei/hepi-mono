export type MpatchHunkOutcome =
	| {
			readonly kind: "applied";
			readonly hunkIndex: number;
			readonly startLine: number;
			readonly length: number;
			readonly match: "exact" | "exact_ignoring_whitespace" | "fuzzy";
			readonly score?: number;
	  }
	| { readonly kind: "context_not_found"; readonly hunkIndex: number }
	| {
			readonly kind: "ambiguous_exact";
			readonly hunkIndex: number;
			readonly candidateStartLines: readonly number[];
	  }
	| {
			readonly kind: "ambiguous_fuzzy";
			readonly hunkIndex: number;
			readonly candidates: readonly { readonly startLine: number; readonly length: number }[];
	  }
	| {
			readonly kind: "fuzzy_below_threshold";
			readonly hunkIndex: number;
			readonly best: {
				readonly startLine: number;
				readonly length: number;
				readonly score: number;
			};
			readonly threshold: number;
	  };

export interface ApplyPatchHunkSnapshot {
	readonly path: string;
	readonly hunkIndex: number;
	readonly startLine: number;
	readonly afterStartLine: number;
	readonly before: readonly string[];
	readonly after: readonly string[];
}

export interface ApplyPatchAppliedOperation {
	readonly operationIndex: number;
	readonly kind: "add" | "delete" | "update";
	readonly paths: readonly string[];
	readonly outcomes: readonly Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[];
	readonly snapshots: readonly ApplyPatchHunkSnapshot[];
}

export interface ApplyPatchRejection {
	readonly operationIndices: readonly number[];
	readonly paths: readonly string[];
	readonly error: string;
	readonly diagnostics: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[];
}

export type ApplyPatchOperationProgress = {
	readonly operationIndex: number;
	readonly kind: "add" | "delete" | "update";
	readonly path: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly status: "pending" | "applied" | "fuzzy" | "rejected";
	readonly score?: number;
};

export interface ApplyPatchProgress {
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
}
