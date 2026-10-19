export {
	type ApplyPatchInWorkspaceOptions,
	applyPatchInWorkspace,
} from "./executor.js";
export {
	APPLY_PATCH_MAX_FILE_SIZE,
	createLocalPatchFs,
	FsTransportError,
	fileTooLarge,
	gcAgentPatchTemps,
	type PatchFs,
	publishPreparedFile,
} from "./fs.js";
export { MUTATION_GLYPH, MUTATION_TONE } from "./glyph.js";
export type {
	ApplyPatchAppliedOperation,
	ApplyPatchHunkSnapshot,
	ApplyPatchInWorkspaceResult,
	ApplyPatchOperationProgress,
	ApplyPatchProgress,
	ApplyPatchRejection,
	PatchHunkOutcome,
	PreparedPatchUpdate,
} from "./outcome.js";
export {
	compileV4aUpdateToUnifiedDiff,
	createV4aPreviewCursor,
	findV4aPatchConflicts,
	MAX_V4A_HUNK_LINES,
	MAX_V4A_HUNKS_PER_UPDATE,
	MAX_V4A_OPERATIONS,
	MAX_V4A_PATCH_BYTES,
	MAX_V4A_PATH_BYTES,
	MAX_V4A_PATH_SEGMENT_BYTES,
	operationTouchedPaths,
	parseV4aPatch,
	parseV4aPatchProgressively,
	previewV4aPatchFileCount,
	previewV4aPatchPrefix,
	type V4aAddedLine,
	type V4aAddOperation,
	type V4aContextLine,
	type V4aDeleteOperation,
	type V4aPatch,
	type V4aPatchConflict,
	type V4aPatchOperation,
	type V4aPreviewCursor,
	type V4aPreviewOperation,
	type V4aRemovedLine,
	type V4aUpdateHunk,
	type V4aUpdateLine,
	type V4aUpdateOperation,
} from "./parser.js";
export {
	type ApplyPatchPolicy,
	DEFAULT_APPLY_PATCH_POLICY,
	type LoadApplyPatchPolicyOptions,
	loadApplyPatchPolicy,
} from "./policy.js";
