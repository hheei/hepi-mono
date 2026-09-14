import { createHash } from "node:crypto";
import { DEFAULT_AGENTMEMORY_URL } from "#core/config/schema/magic-context";
import { log } from "#core/shared/logger";
import { createPlaintextBearerAuthGuard, plaintextBearerAuthMessage } from "./security";

export type AgentMemoryClientErrorKind =
	| "invalid_url"
	| "insecure_transport"
	| "http"
	| "network"
	| "timeout"
	| "cancelled"
	| "invalid_response";

export class AgentMemoryClientError extends Error {
	readonly kind: AgentMemoryClientErrorKind;
	readonly endpoint: string;
	readonly status: number | undefined;

	constructor(
		kind: AgentMemoryClientErrorKind,
		endpoint: string,
		message: string,
		status?: number,
		cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AgentMemoryClientError";
		this.kind = kind;
		this.endpoint = endpoint;
		this.status = status;
	}
}

export type AgentMemoryRequestOptions = {
	signal?: AbortSignal | undefined;
	timeoutMs?: number | undefined;
};

export type HealthResult = {
	status?: string | undefined;
	health?: { status?: string | undefined } | undefined;
};

export type StartSessionInput = {
	sessionId: string;
	project: string;
	cwd: string;
	agentId?: string | undefined;
};

export type StartSessionResult = {
	sessionId: string;
};

export type ObserveInput = {
	sessionId: string;
	project?: string | undefined;
	hookType: string;
	timestamp?: string | undefined;
	cwd?: string | undefined;
	data: Record<string, unknown>;
};

export type ObserveResult = {
	observationId?: string | undefined;
};

export type SearchInput = {
	query: string;
	limit?: number | undefined;
	project: string;
	agentId?: string | undefined;
	format?: "full" | undefined;
};

export type SearchResult = {
	results?: unknown[] | undefined;
	observations?: unknown[] | undefined;
	memories?: unknown[] | undefined;
};

export type DecodedSearchEntry = {
	id: string;
	content: string;
	kind: "memory" | "observation";
	score?: number | undefined;
	project?: string | undefined;
	sessionId?: string | undefined;
	agentId?: string | undefined;
	digest: string;
};

export type RememberInput = {
	content: string;
	type?: string | undefined;
	project: string;
	agentId?: string | undefined;
};

export type RememberResult = {
	success: true;
	memory: { id: string };
};

export type AgentMemoryClientPort = {
	health(options?: AgentMemoryRequestOptions): Promise<HealthResult>;
	startSession(
		input: StartSessionInput,
		options?: AgentMemoryRequestOptions,
	): Promise<StartSessionResult>;
	observe(input: ObserveInput, options?: AgentMemoryRequestOptions): Promise<ObserveResult>;
	search(input: SearchInput, options?: AgentMemoryRequestOptions): Promise<SearchResult>;
	remember(input: RememberInput, options?: AgentMemoryRequestOptions): Promise<RememberResult>;
	endSession(sessionId: string, options?: AgentMemoryRequestOptions): Promise<void>;
};

export type AgentMemoryClientConfig = {
	url?: string | undefined;
	secret?: string | undefined;
	requireHttps?: boolean | undefined;
};

const DEFAULT_TIMEOUTS = {
	health: 1_000,
	startSession: 3_000,
	observe: 1_500,
	search: 3_000,
	remember: 4_000,
	endSession: 2_000,
} as const;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function searchContent(value: Record<string, unknown>): string | undefined {
	for (const key of ["content", "text", "narrative", "summary", "description"] as const) {
		const content = nonEmpty(value[key]);
		if (content) return content;
	}
	return undefined;
}

export function decodeAgentMemorySearchResults(body: SearchResult): DecodedSearchEntry[] {
	const sources: Array<{ values: unknown[]; kind: DecodedSearchEntry["kind"] }> = [
		{ values: Array.isArray(body.results) ? body.results : [], kind: "memory" },
		{ values: Array.isArray(body.memories) ? body.memories : [], kind: "memory" },
		{ values: Array.isArray(body.observations) ? body.observations : [], kind: "observation" },
	];
	return sources.flatMap(({ values, kind }) =>
		values.flatMap((raw, index) => {
			const wrapper = record(raw);
			if (!wrapper) return [];
			const nestedObservation = record(wrapper.observation);
			const nestedMemory = record(wrapper.memory);
			const value = nestedObservation ?? nestedMemory ?? wrapper;
			const resolvedKind = nestedObservation ? "observation" : kind;
			const content = searchContent(value);
			if (!content) return [];
			const id =
				nonEmpty(value.id) ??
				nonEmpty(value.observationId) ??
				nonEmpty(value.memoryId) ??
				nonEmpty(wrapper.id) ??
				`${resolvedKind}-${index}`;
			const score =
				typeof wrapper.score === "number" && Number.isFinite(wrapper.score)
					? wrapper.score
					: undefined;
			const project =
				nonEmpty(value.project) ??
				nonEmpty(value.projectName) ??
				nonEmpty(value.project_name) ??
				nonEmpty(wrapper.project) ??
				nonEmpty(wrapper.projectName) ??
				nonEmpty(wrapper.project_name);
			const sessionId =
				nonEmpty(wrapper.sessionId) ??
				nonEmpty(wrapper.session_id) ??
				nonEmpty(value.sessionId) ??
				nonEmpty(value.session_id);
			const agentId =
				nonEmpty(value.agentId) ??
				nonEmpty(value.agent_id) ??
				nonEmpty(wrapper.agentId) ??
				nonEmpty(wrapper.agent_id);
			return [
				{
					id,
					content,
					digest: createHash("sha256").update(content).digest("hex"),
					kind: resolvedKind,
					...(score === undefined ? {} : { score }),
					...(project ? { project } : {}),
					...(sessionId ? { sessionId } : {}),
					...(agentId ? { agentId } : {}),
				},
			];
		}),
	);
}

function successfulBody(value: unknown, endpoint: string): Record<string, unknown> {
	const body = record(value);
	if (!body) {
		throw new AgentMemoryClientError(
			"invalid_response",
			endpoint,
			"agentmemory returned a non-object JSON body",
		);
	}
	if (body.success === false || body.ok === false) {
		throw new AgentMemoryClientError(
			"invalid_response",
			endpoint,
			"agentmemory reported an unsuccessful response",
		);
	}
	return body;
}

export class AgentMemoryClient implements AgentMemoryClientPort {
	readonly #baseUrl: string;
	readonly #secret: string;
	readonly #requireHttps: boolean;
	readonly #guardPlaintextBearer: (baseUrl: string, secret?: string) => void;
	readonly #fetch: typeof fetch;

	constructor(config: AgentMemoryClientConfig = {}, fetchImpl: typeof fetch = globalThis.fetch) {
		const url = normalizeBaseUrl(config.url?.trim() || DEFAULT_AGENTMEMORY_URL);
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error("unsupported protocol");
			}
		} catch (error) {
			throw new AgentMemoryClientError(
				"invalid_url",
				"client",
				`Invalid agentmemory URL: ${url}`,
				undefined,
				error,
			);
		}
		this.#baseUrl = url;
		this.#secret = config.secret?.trim() ?? "";
		this.#requireHttps = config.requireHttps === true;
		this.#guardPlaintextBearer = createPlaintextBearerAuthGuard({
			requireHttps: this.#requireHttps,
			warn: (message) => log(`[magic-context][agentmemory] ${message}`),
		});
		this.#fetch = fetchImpl;
	}

	async health(options?: AgentMemoryRequestOptions): Promise<HealthResult> {
		const body = successfulBody(
			await this.#request("health", "GET", undefined, options, DEFAULT_TIMEOUTS.health),
			"health",
		);
		const status = nonEmpty(body.status) ?? nonEmpty(record(body.health)?.status);
		if (!status || !["ok", "healthy", "ready", "up"].includes(status.toLowerCase())) {
			throw new AgentMemoryClientError(
				"invalid_response",
				"health",
				"agentmemory health response has no healthy status",
			);
		}
		return body as HealthResult;
	}

	async startSession(
		input: StartSessionInput,
		options?: AgentMemoryRequestOptions,
	): Promise<StartSessionResult> {
		const body = successfulBody(
			await this.#request("session/start", "POST", input, options, DEFAULT_TIMEOUTS.startSession),
			"session/start",
		);
		const nested = record(body.session);
		const returnedId = nonEmpty(body.sessionId) ?? nonEmpty(nested?.id) ?? nonEmpty(body.id);
		return { sessionId: returnedId ?? input.sessionId };
	}

	async observe(input: ObserveInput, options?: AgentMemoryRequestOptions): Promise<ObserveResult> {
		const body = successfulBody(
			await this.#request(
				"observe",
				"POST",
				{ timestamp: new Date().toISOString(), ...input },
				options,
				DEFAULT_TIMEOUTS.observe,
			),
			"observe",
		);
		const observationId = nonEmpty(body.observationId) ?? nonEmpty(body.id);
		return observationId ? { observationId } : {};
	}

	async search(input: SearchInput, options?: AgentMemoryRequestOptions): Promise<SearchResult> {
		const body = successfulBody(
			await this.#request(
				"search",
				"POST",
				{ format: "full", ...input },
				options,
				DEFAULT_TIMEOUTS.search,
			),
			"search",
		);
		if (!["results", "observations", "memories"].some((key) => Array.isArray(body[key]))) {
			throw new AgentMemoryClientError(
				"invalid_response",
				"search",
				"search response has no result list",
			);
		}
		return body as SearchResult;
	}

	async remember(
		input: RememberInput,
		options?: AgentMemoryRequestOptions,
	): Promise<RememberResult> {
		const body = successfulBody(
			await this.#request("remember", "POST", input, options, DEFAULT_TIMEOUTS.remember),
			"remember",
		);
		if (body.success !== true) {
			throw new AgentMemoryClientError(
				"invalid_response",
				"remember",
				"remember response did not confirm success",
			);
		}
		const memory = record(body.memory);
		const id = nonEmpty(memory?.id);
		if (!memory || !id) {
			throw new AgentMemoryClientError(
				"invalid_response",
				"remember",
				"remember response has no memory id",
			);
		}
		return { success: true, memory: { id } };
	}

	async endSession(sessionId: string, options?: AgentMemoryRequestOptions): Promise<void> {
		const body = successfulBody(
			await this.#request(
				"session/end",
				"POST",
				{ sessionId },
				options,
				DEFAULT_TIMEOUTS.endSession,
			),
			"session/end",
		);
		if (body.ended === false || body.success === false || body.ok === false) {
			throw new AgentMemoryClientError(
				"invalid_response",
				"session/end",
				"session/end response did not confirm completion",
			);
		}
	}

	async #request(
		pathname: string,
		method: "GET" | "POST",
		body: unknown,
		options: AgentMemoryRequestOptions | undefined,
		defaultTimeoutMs: number,
	): Promise<unknown> {
		try {
			this.#guardPlaintextBearer(this.#baseUrl, this.#secret);
		} catch (error) {
			throw new AgentMemoryClientError(
				"insecure_transport",
				pathname,
				plaintextBearerAuthMessage(this.#baseUrl),
				undefined,
				error,
			);
		}
		const headers = new Headers();
		if (this.#secret) headers.set("Authorization", `Bearer ${this.#secret}`);
		if (body !== undefined) headers.set("Content-Type", "application/json");
		const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = options?.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;
		let response: Response;
		try {
			response = await this.#fetch(
				`${this.#baseUrl}/agentmemory/${pathname.replace(/^\/+/, "")}`,
				body === undefined
					? { method, headers, signal }
					: { method, headers, signal, body: JSON.stringify(body) },
			);
		} catch (error) {
			const aborted = signal.aborted;
			const timeout = timeoutSignal.aborted && options?.signal?.aborted !== true;
			throw new AgentMemoryClientError(
				timeout ? "timeout" : aborted ? "cancelled" : "network",
				pathname,
				timeout ? `agentmemory ${pathname} timed out` : `agentmemory ${pathname} request failed`,
				undefined,
				error,
			);
		}
		if (!response.ok) {
			throw new AgentMemoryClientError(
				"http",
				pathname,
				`agentmemory ${pathname} returned HTTP ${response.status}`,
				response.status,
			);
		}
		try {
			return await response.json();
		} catch (error) {
			throw new AgentMemoryClientError(
				"invalid_response",
				pathname,
				`agentmemory ${pathname} returned invalid JSON`,
				response.status,
				error,
			);
		}
	}
}
