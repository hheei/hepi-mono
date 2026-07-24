export {
	type CacheDebugOptions,
	DEBUG_GUIDE_URL,
	default,
	registerCacheDebug,
} from "./extension.js";
export {
	comparePayloadSnapshots,
	type FirstChangedItem,
	type ItemDigest,
	type ModuleDigest,
	type PayloadComparison,
	type PayloadSnapshot,
	requestLogSnapshot,
	snapshotProviderPayload,
	type ValueDigest,
} from "./probe.js";
