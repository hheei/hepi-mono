export {
	type ApplyPatchThroughCoordinatorOptions,
	applyPatchThroughCoordinator,
	coordinatorSocketPath,
} from "./coordinator-client.js";
export { startApplyPatchCoordinatorServer } from "./coordinator-server.js";
export {
	type ApplyPatchInWorkspaceOptions,
	type ApplyPatchInWorkspaceResult,
	applyPatchInWorkspace,
} from "./executor.js";
export {
	compileV4aUpdateToUnifiedDiff,
	parseV4aPatch,
	type V4aAddedLine,
	type V4aAddOperation,
	type V4aContextLine,
	type V4aDeleteOperation,
	type V4aPatch,
	type V4aPatchOperation,
	type V4aRemovedLine,
	type V4aUpdateHunk,
	type V4aUpdateLine,
	type V4aUpdateOperation,
} from "./parser.js";
export {
	DEFAULT_FUZZY_APPLY_PATCH_POLICY,
	type FuzzyApplyPatchPolicy,
	type LoadFuzzyApplyPatchPolicyOptions,
	loadFuzzyApplyPatchPolicy,
} from "./policy.js";
