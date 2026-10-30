import { normalizeProxyUrl } from "./utils.ts";

export const FETCH_MODES = ["readable", "raw", "answer"] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

export interface FetchModeConfig {
	defaultMode: FetchMode;
	allowedModes: readonly FetchMode[];
}

export interface FetchContentParams {
	url?: unknown;
	urls?: unknown;
	forceClone?: unknown;
	prompt?: unknown;
	timestamp?: unknown;
	frames?: unknown;
	model?: unknown;
	mode?: unknown;
	answerModel?: unknown;
	auth?: unknown;
	proxy?: unknown;
	redirects?: unknown;
}

export interface NormalizedFetchContentParams {
	urlList: string[];
	options: {
		forceClone?: boolean;
		prompt?: string;
		timestamp?: string;
		frames?: number;
		model?: string;
		mode?: FetchMode;
		answerModel?: string;
		auth?: true | string;
		proxy?: string;
		redirects?: "same-origin";
	};
}

function normalizeFetchContentParams(params: FetchContentParams): NormalizedFetchContentParams {
	const normalizedUrls = uniqueUrls(normalizeUrlArray(params.urls));
	const urlList = normalizedUrls.length > 0 ? normalizedUrls : normalizeSingleUrl(params.url);
	const prompt = normalizeOptionalString(params.prompt);
	const timestamp = normalizeOptionalString(params.timestamp);
	const frames = normalizeOptionalFrameCount(params.frames);

	const shouldIncludeFrames = frames !== undefined && (timestamp !== undefined || frames > 1);

	const forceClone = typeof params.forceClone === "boolean" ? params.forceClone : undefined;
	const model = normalizeOptionalString(params.model);
	const mode = normalizeMode(params.mode);
	const answerModel = normalizeOptionalString(params.answerModel);
	const auth = normalizeAuth(params.auth);
	const proxy = normalizeProxy(params.proxy);
	const redirects = normalizeRedirects(params.redirects);

	return {
		urlList,
		options: {
			...(forceClone !== undefined ? { forceClone } : {}),
			...(prompt !== undefined ? { prompt } : {}),
			...(timestamp !== undefined ? { timestamp } : {}),
			...(shouldIncludeFrames ? { frames } : {}),
			...(model !== undefined ? { model } : {}),
			...(mode !== undefined ? { mode } : {}),
			...(answerModel !== undefined ? { answerModel } : {}),
			...(auth !== undefined ? { auth } : {}),
			...(proxy !== undefined ? { proxy } : {}),
			...(redirects !== undefined ? { redirects } : {}),
		},
	};
}

function normalizeUrlArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(normalizeSingleUrl);
}

function normalizeSingleUrl(value: unknown): string[] {
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	return trimmed ? [trimmed] : [];
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function normalizeMode(value: unknown): FetchMode | undefined {
	if (value === undefined) return undefined;
	if (value === "readable" || value === "raw" || value === "answer") return value;
	throw new Error('mode must be "readable", "raw", or "answer"');
}

function normalizeRedirects(value: unknown): "same-origin" | undefined {
	if (value === undefined) return undefined;
	if (value === "same-origin") return value;
	throw new Error('redirects must be "same-origin"');
}

function normalizeAuth(value: unknown): true | string | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === true) return true;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	throw new Error("auth must be a profile name, true, or false");
}

function normalizeProxy(value: unknown): string | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === null) throw new Error("proxy must be an http(s) or socks proxy URL string");
	const normalized = normalizeProxyUrl(value, "proxy");
	return normalized ?? "";
}

function normalizeOptionalFrameCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 12)
		return undefined;
	return value;
}

function uniqueUrls(urls: string[]): string[] {
	return [...new Set(urls)];
}

export interface FetchRequest {
	urlList: string[];
	mode: FetchMode;
	options: NormalizedFetchContentParams["options"];
}

/** Normalizes fetch parameters and rejects the combinations the effective mode cannot honor. */
export function resolveFetchRequest(
	params: FetchContentParams,
	config: FetchModeConfig,
): FetchRequest {
	const { urlList, options } = normalizeFetchContentParams(params);
	const mode = options.mode ?? config.defaultMode;
	if (!config.allowedModes.includes(mode))
		throw new Error(`Fetch mode "${mode}" is disabled by fetch.allowedModes.`);
	if (mode === "answer" && !options.prompt) throw new Error("mode answer requires prompt.");
	if (
		mode === "raw" &&
		(options.forceClone === true ||
			options.timestamp ||
			options.frames ||
			options.prompt ||
			options.model ||
			options.answerModel)
	)
		throw new Error(
			"mode raw cannot be combined with forceClone, prompt, timestamp, frames, model, or answerModel.",
		);
	if (mode !== "answer" && options.answerModel)
		throw new Error("answerModel requires mode answer.");
	if (mode === "answer" && options.model)
		throw new Error("use answerModel, not model, with mode answer.");
	if (mode === "answer" && options.auth !== undefined)
		throw new Error("auth cannot be combined with mode answer.");
	if (urlList.length === 0)
		throw new Error("No URL provided. Use the 'url' parameter, or 'urls' for parallel fetches.");
	return { urlList, mode, options };
}
