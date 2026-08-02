import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import type {
	FileItem as EngineFileItem,
	GrepMatch as EngineGrepMatch,
	Result as EngineResult,
	FileFinder,
	GrepCursor,
	GrepMode,
	GrepResult,
	HealthCheck,
	Location,
	Score,
} from "@ff-labs/fff-node";
import type { GrepSearchError, PathResolutionError, RelatedFilesError } from "./errors.js";
import type { AppResult } from "./result-utils.js";

export type FileItem = EngineFileItem & { path?: string };
export type GrepMatch = EngineGrepMatch & { path?: string };

export const DEFAULT_FILE_CANDIDATE_LIMIT = 8;
export const DEFAULT_GREP_LIMIT = 100;
export const DEFAULT_GREP_TIMEOUT_MS = 30_000;
export const MAX_MATCHES_PER_FILE = 200;
export const AUTO_EXPAND_AFTER_CONTEXT = 6;
export const MAX_AUTO_EXPAND_LINES = 5;
export const CROPPED_MATCH_LINE_WIDTH = 180;
export const GREP_CURSOR_PREFIX = "grep:";

export type FffFileCandidate = {
	item: FileItem;
	score?: Score;
};

export type ResolvedPath = {
	kind: "resolved";
	query: string;
	absolutePath: string;
	relativePath: string;
	pathType: "file" | "directory";
	location?: Location;
	candidates: FffFileCandidate[];
};

export type PathResolution = AppResult<ResolvedPath, PathResolutionError>;

export type GrepOutputMode = "content" | "files_with_matches" | "count" | "usage";

/** User-facing grep request. Limits and cursor semantics are normalized by the FFF tool layer. */
export type GrepSearchRequest = {
	pattern: string;
	mode?: GrepMode;
	pathQuery?: string;
	glob?: string;
	constraints?: string;
	context?: number;
	limit?: number;
	timeBudgetMs?: number;
	cursor?: string;
	includeCursorHint?: boolean;
	outputMode?: GrepOutputMode;
};

export type GrepSearchResponse = {
	items: GrepMatch[];
	formatted: string;
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated: boolean;
	regexFallbackError?: string;
	scope?: ResolvedPath;
	nextCursor?: string;
	constraintQuery?: string;
	suggestedReadPath?: string;
};

export type RelatedFilesResponse = {
	base: ResolvedPath;
	items: FffFileCandidate[];
};

export type RelatedFilesResult = AppResult<RelatedFilesResponse, RelatedFilesError>;
export type GrepSearchResult = AppResult<GrepSearchResponse, GrepSearchError>;

export type GrepBaseRequest = {
	pathQuery?: string;
	glob?: string;
	constraints?: string;
	context: number;
	limit: number;
	timeBudgetMs: number;
	cursor?: string;
	includeCursorHint?: boolean;
	outputMode?: GrepOutputMode;
};

export type SingleGrepRequest = GrepBaseRequest & {
	kind: "single";
	pattern: string;
	mode: GrepMode;
};

export type MultiGrepRequest = GrepBaseRequest & {
	kind: "multi";
	patterns: string[];
};

export type RuntimeOptions = {
	/** Optional injected finder for tests or an embedding host; FFF owns created finders. */
	finder?: FileFinder;
	/** Project root used for indexing and database partitioning; defaults to the current directory. */
	projectRoot?: string;
};

/** Diagnostic paths exposed by commands; these are not part of the tool result contract. */
export type RuntimeMetadata = {
	cwd: string;
	projectRoot: string;
	dbDir: string;
	frecencyDbPath: string;
	historyDbPath: string;
	definitionClassification: "heuristic" | "native";
};

export type {
	EngineResult,
	FileFinder,
	GrepCursor,
	GrepMode,
	GrepResult,
	HealthCheck,
	Location,
	Score,
};
