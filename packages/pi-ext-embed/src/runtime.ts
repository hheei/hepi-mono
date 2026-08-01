import { mkdir, open, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
	EmbeddingProvider,
	EmbeddingProviderConfig,
	EmbeddingProviderLease,
	EmbeddingPurpose,
	EmbeddingSnapshot,
} from "./types.js";

const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";
const CACHE_LOCK_NAME = ".pi-ext-embed-load.lock";
const CACHE_LOCK_STALE_MS = 30_000;
const CACHE_LOCK_WAIT_MS = 30_000;
const CACHE_LOCK_RETRY_MS = 100;

type JsonScalar = string | number | boolean;

interface LocalConfig {
	readonly provider: "local";
	readonly model: string;
	readonly cacheDir: string;
	readonly key: string;
}

interface SynapseConfig {
	readonly provider: "synapse";
	readonly connectionFile: string;
	readonly model: string;
	readonly projectRoot: string;
	readonly session: string;
	readonly metadata?: Readonly<Record<string, JsonScalar>>;
	readonly connectionKey: string;
	readonly key: string;
}

type ParsedConfig = { readonly provider: "off" } | LocalConfig | SynapseConfig;

interface LocalPipeline {
	embed(text: string): Promise<unknown>;
	dispose?(): Promise<void> | void;
}

interface SynapseConnection {
	call(method: string, params: unknown): Promise<unknown>;
	close(): void;
}

interface SynapseModel {
	readonly model: string;
	readonly fingerprint: string;
	readonly epoch: number;
	readonly dimensions?: number;
}

interface ClientLease {
	readonly key: string;
	readonly client: SynapseConnection;
}

export interface EmbeddingRuntimeSeams {
	readonly loadLocal?: (config: Readonly<LocalConfig>) => Promise<LocalPipeline>;
	readonly connectSynapse?: (config: Readonly<SynapseConfig>) => Promise<SynapseConnection>;
}

interface PoolEntry {
	retain(): void;
	release(): Promise<void>;
	createLeaseProvider(): LeaseProvider;
}

interface LeaseProvider {
	readonly provider: EmbeddingProvider;
	deactivate(): void;
}

class LocalEntry implements PoolEntry {
	private refs = 0;
	private activeCalls = 0;
	private readonly idleResolvers: Array<() => void> = [];
	private pipeline: LocalPipeline | undefined;
	private loading: Promise<LocalPipeline> | undefined;
	private retiring: Promise<void> | undefined;
	private dimensions: number | undefined;

	constructor(
		private readonly config: LocalConfig,
		private readonly generation: number,
		private readonly loader: (config: Readonly<LocalConfig>) => Promise<LocalPipeline>,
		private readonly remove: () => void,
	) {}

	retain(): void {
		if (this.retiring !== undefined) throw new Error("Embedding provider is retiring");
		this.refs += 1;
	}

	createLeaseProvider(): LeaseProvider {
		let released = false;
		return {
			provider: {
				snapshot: () => (released ? undefined : this.snapshot()),
				embed: async (text, purpose, signal) => {
					if (released) return undefined;
					validateEmbedInput(text, purpose, signal);
					return this.embed(text, signal);
				},
				embedBatch: async (items, purpose, signal) => {
					if (released) return undefined;
					validateBatchInput(items, purpose, signal);
					return this.embedBatch(items, signal);
				},
			},
			deactivate: () => {
				released = true;
			},
		};
	}

	async release(): Promise<void> {
		if (this.refs < 1) return;
		this.refs -= 1;
		if (this.refs > 0) return;
		this.remove();
		this.retiring = this.shutdown();
		await this.retiring;
	}

	private snapshot(): EmbeddingSnapshot {
		return {
			provider: "local",
			modelIdentity: this.config.model,
			generation: this.generation,
			...(this.dimensions === undefined ? {} : { dimensions: this.dimensions }),
		};
	}

	private async embed(text: string, signal: AbortSignal): Promise<Float32Array | undefined> {
		if (signal.aborted) return undefined;
		return this.withCall(signal, async () => {
			const pipeline = await this.getPipeline();
			if (pipeline === undefined) return undefined;
			const vector = toVector(await pipeline.embed(text), this.dimensions);
			if (vector === undefined) return undefined;
			this.dimensions = vector.length;
			return vector;
		});
	}

	private async embedBatch(
		items: ReadonlyArray<{
			readonly id: string;
			readonly text: string;
			readonly contentHash: string;
		}>,
		signal: AbortSignal,
	): Promise<ReadonlyMap<string, Float32Array> | undefined> {
		if (signal.aborted) return undefined;
		return this.withCall(signal, async () => {
			const pipeline = await this.getPipeline();
			if (pipeline === undefined) return undefined;
			const vectors = new Map<string, Float32Array>();
			for (const item of items) {
				if (signal.aborted) return undefined;
				const vector = toVector(await pipeline.embed(item.text), this.dimensions);
				if (vector === undefined) return undefined;
				this.dimensions = vector.length;
				vectors.set(item.id, vector);
			}
			return vectors;
		});
	}

	private async getPipeline(): Promise<LocalPipeline | undefined> {
		if (this.pipeline !== undefined) return this.pipeline;
		this.loading ??= this.loader(this.config);
		try {
			this.pipeline = await this.loading;
			return this.pipeline;
		} catch {
			return undefined;
		}
	}

	private withCall<T>(
		signal: AbortSignal,
		operation: () => Promise<T | undefined>,
	): Promise<T | undefined> {
		this.activeCalls += 1;
		const work = operation()
			.catch(() => undefined)
			.finally(() => {
				this.activeCalls -= 1;
				this.resolveIdle();
			});
		return undefinedOnAbort(work, signal);
	}

	private async shutdown(): Promise<void> {
		await this.waitForIdle();
		try {
			await this.pipeline?.dispose?.();
		} catch {
			// Disposal is best-effort; a later process gets its own in-memory pipeline.
		}
	}

	private waitForIdle(): Promise<void> {
		if (this.activeCalls === 0) return Promise.resolve();
		return new Promise((resolveIdle) => this.idleResolvers.push(resolveIdle));
	}

	private resolveIdle(): void {
		if (this.activeCalls !== 0) return;
		for (const resolveIdle of this.idleResolvers.splice(0)) resolveIdle();
	}
}

class SynapseEntry implements PoolEntry {
	private refs = 0;
	private activeCalls = 0;
	private readonly idleResolvers: Array<() => void> = [];
	private retiring: Promise<void> | undefined;
	private clientLease: Promise<ClientLease | undefined> | undefined;
	private model: SynapseModel | undefined;
	private modelLoading: Promise<SynapseModel | undefined> | undefined;

	constructor(
		private readonly config: SynapseConfig,
		private readonly generation: number,
		private readonly retainClient: (config: SynapseConfig) => Promise<ClientLease | undefined>,
		private readonly releaseClient: (lease: ClientLease) => void,
		private readonly remove: () => void,
	) {}

	retain(): void {
		if (this.retiring !== undefined) throw new Error("Embedding provider is retiring");
		this.refs += 1;
	}

	createLeaseProvider(): LeaseProvider {
		let released = false;
		return {
			provider: {
				snapshot: () => (released ? undefined : this.snapshot()),
				embed: async (text, purpose, signal) => {
					if (released) return undefined;
					validateEmbedInput(text, purpose, signal);
					return this.embed(text, purpose, signal);
				},
				embedBatch: async (items, purpose, signal) => {
					if (released) return undefined;
					validateBatchInput(items, purpose, signal);
					return this.embedBatch(items, purpose, signal);
				},
			},
			deactivate: () => {
				released = true;
			},
		};
	}

	async release(): Promise<void> {
		if (this.refs < 1) return;
		this.refs -= 1;
		if (this.refs > 0) return;
		this.remove();
		this.retiring = this.shutdown();
		await this.retiring;
	}

	private snapshot(): EmbeddingSnapshot {
		return {
			provider: "synapse",
			modelIdentity: this.config.model,
			generation: this.generation,
			...(this.model?.dimensions === undefined ? {} : { dimensions: this.model.dimensions }),
		};
	}

	private async embed(
		text: string,
		purpose: EmbeddingPurpose,
		signal: AbortSignal,
	): Promise<Float32Array | undefined> {
		if (signal.aborted) return undefined;
		return this.withCall(signal, async () => {
			const client = await this.getClient();
			const model = await this.getModel(client);
			if (client === undefined || model === undefined) return undefined;
			const response = await client.call("embed.query", {
				...requestConstraints(model, purpose, this.config.metadata),
				text,
			});
			return toVector(vectorFromResponse(response), model.dimensions);
		});
	}

	private async embedBatch(
		items: ReadonlyArray<{
			readonly id: string;
			readonly text: string;
			readonly contentHash: string;
		}>,
		purpose: EmbeddingPurpose,
		signal: AbortSignal,
	): Promise<ReadonlyMap<string, Float32Array> | undefined> {
		if (signal.aborted) return undefined;
		return this.withCall(signal, async () => {
			const client = await this.getClient();
			const model = await this.getModel(client);
			if (client === undefined || model === undefined) return undefined;
			const response = await client.call("embed.batch", {
				...requestConstraints(model, purpose, this.config.metadata),
				items: items.map((item) => ({
					id: item.id,
					text: item.text,
					contentHash: item.contentHash,
				})),
			});
			return batchVectorsFromResponse(response, items, model.dimensions);
		});
	}

	private async getClient(): Promise<SynapseConnection | undefined> {
		this.clientLease ??= this.retainClient(this.config);
		try {
			return (await this.clientLease)?.client;
		} catch {
			return undefined;
		}
	}

	private async getModel(client: SynapseConnection | undefined): Promise<SynapseModel | undefined> {
		if (client === undefined) return undefined;
		if (this.model !== undefined) return this.model;
		this.modelLoading ??= this.loadModel(client);
		this.model = await this.modelLoading;
		return this.model;
	}

	private async loadModel(client: SynapseConnection): Promise<SynapseModel | undefined> {
		try {
			return modelFromList(await client.call("models.list", {}), this.config.model);
		} catch {
			return undefined;
		}
	}

	private withCall<T>(
		signal: AbortSignal,
		operation: () => Promise<T | undefined>,
	): Promise<T | undefined> {
		this.activeCalls += 1;
		const work = operation()
			.catch(() => undefined)
			.finally(() => {
				this.activeCalls -= 1;
				this.resolveIdle();
			});
		return undefinedOnAbort(work, signal);
	}

	private async shutdown(): Promise<void> {
		await this.waitForIdle();
		try {
			const lease = await this.clientLease;
			if (lease !== undefined) this.releaseClient(lease);
		} catch {
			// Failed connections never become retained clients.
		}
	}

	private waitForIdle(): Promise<void> {
		if (this.activeCalls === 0) return Promise.resolve();
		return new Promise((resolveIdle) => this.idleResolvers.push(resolveIdle));
	}

	private resolveIdle(): void {
		if (this.activeCalls !== 0) return;
		for (const resolveIdle of this.idleResolvers.splice(0)) resolveIdle();
	}
}

interface SharedClient {
	refs: number;
	client: SynapseConnection | undefined;
	loading: Promise<SynapseConnection> | undefined;
}

/** Internal factory keeps production imports lazy while allowing model-free tests. */
export class EmbeddingRuntime {
	private readonly localPool = new Map<string, LocalEntry>();
	private readonly synapsePool = new Map<string, SynapseEntry>();
	private readonly clients = new Map<string, SharedClient>();
	private generation = 0;
	private readonly loadLocal: (config: Readonly<LocalConfig>) => Promise<LocalPipeline>;
	private readonly connectSynapse: (config: Readonly<SynapseConfig>) => Promise<SynapseConnection>;

	constructor(seams: EmbeddingRuntimeSeams = {}) {
		this.loadLocal = seams.loadLocal ?? loadTransformersPipeline;
		this.connectSynapse = seams.connectSynapse ?? connectSubcSynapse;
	}

	async acquire(
		config: EmbeddingProviderConfig | unknown,
	): Promise<EmbeddingProviderLease | undefined> {
		const parsed = parseConfig(config);
		if (parsed.provider === "off") return undefined;
		const entry = parsed.provider === "local" ? this.localEntry(parsed) : this.synapseEntry(parsed);
		entry.retain();
		const leasedProvider = entry.createLeaseProvider();
		let releasePromise: Promise<void> | undefined;
		return {
			provider: leasedProvider.provider,
			release: () => {
				releasePromise ??= (async () => {
					leasedProvider.deactivate();
					await entry.release();
				})();
				return releasePromise;
			},
		};
	}

	private localEntry(config: LocalConfig): LocalEntry {
		const existing = this.localPool.get(config.key);
		if (existing !== undefined) return existing;
		let entry: LocalEntry | undefined;
		entry = new LocalEntry(config, this.nextGeneration(), this.loadLocal, () => {
			if (this.localPool.get(config.key) === entry) this.localPool.delete(config.key);
		});
		this.localPool.set(config.key, entry);
		return entry;
	}

	private synapseEntry(config: SynapseConfig): SynapseEntry {
		const existing = this.synapsePool.get(config.key);
		if (existing !== undefined) return existing;
		let entry: SynapseEntry | undefined;
		entry = new SynapseEntry(
			config,
			this.nextGeneration(),
			async (clientConfig) => this.retainClient(clientConfig),
			(lease) => this.releaseClient(lease),
			() => {
				if (this.synapsePool.get(config.key) === entry) this.synapsePool.delete(config.key);
			},
		);
		this.synapsePool.set(config.key, entry);
		return entry;
	}

	private nextGeneration(): number {
		this.generation += 1;
		return this.generation;
	}

	private async retainClient(config: SynapseConfig): Promise<ClientLease | undefined> {
		let entry = this.clients.get(config.connectionKey);
		if (entry === undefined) {
			entry = { refs: 0, client: undefined, loading: undefined };
			this.clients.set(config.connectionKey, entry);
		}
		entry.loading ??= this.connectSynapse(config);
		try {
			entry.client ??= await entry.loading;
			entry.refs += 1;
			return { key: config.connectionKey, client: entry.client };
		} catch {
			if (entry.refs === 0 && this.clients.get(config.connectionKey) === entry)
				this.clients.delete(config.connectionKey);
			return undefined;
		}
	}

	private releaseClient(lease: ClientLease): void {
		const entry = this.clients.get(lease.key);
		if (entry === undefined || entry.client !== lease.client || entry.refs < 1) return;
		entry.refs -= 1;
		if (entry.refs > 0) return;
		this.clients.delete(lease.key);
		try {
			entry.client.close();
		} catch {
			// Transport close cannot invalidate another process's independent connection.
		}
	}
}

function parseConfig(value: unknown): ParsedConfig {
	if (!isRecord(value)) throw new TypeError("Embedding provider config must be an object");
	const provider = value.provider;
	if (provider === undefined || provider === "local") {
		assertKnownKeys(value, ["provider", "model", "cacheDir"]);
		const model = readOptionalString(value, "model") ?? DEFAULT_LOCAL_MODEL;
		const cacheDir =
			readOptionalString(value, "cacheDir") ?? join(homedir(), ".cache", "hepi", "embeddings");
		return {
			provider: "local",
			model,
			cacheDir: resolve(cacheDir),
			key: `local:${model}\u0000${resolve(cacheDir)}`,
		};
	}
	if (provider === "off") {
		assertKnownKeys(value, ["provider"]);
		return { provider: "off" };
	}
	if (provider === "openai-compatible")
		throw new TypeError("openai-compatible embeddings are not supported");
	if (provider !== "synapse") throw new TypeError("Unsupported embedding provider");
	assertKnownKeys(value, [
		"provider",
		"connectionFile",
		"model",
		"projectRoot",
		"session",
		"metadata",
	]);
	const connectionFile = resolve(readRequiredString(value, "connectionFile"));
	const model = readRequiredString(value, "model");
	const projectRoot = resolve(readRequiredString(value, "projectRoot"));
	const session = readRequiredString(value, "session");
	const metadata = readMetadata(value.metadata);
	// Subc routes are identity-scoped per call, so one socket can serve every
	// project/session using this connection file. Pooling by session duplicates
	// transport state without isolating the shared Synapse model runtime.
	const connectionKey = connectionFile;
	return {
		provider: "synapse",
		connectionFile,
		model,
		projectRoot,
		session,
		...(metadata === undefined ? {} : { metadata }),
		connectionKey,
		key: `synapse:${connectionKey}\u0000${model}\u0000${stableMetadata(metadata)}`,
	};
}

async function loadTransformersPipeline(config: Readonly<LocalConfig>): Promise<LocalPipeline> {
	// The lock protects cache download/load initialization only; pipelines remain process-local.
	return withCacheLock(config.cacheDir, async () => {
		const transformers = await import("@huggingface/transformers");
		const extractor = await transformers.pipeline("feature-extraction", config.model, {
			cache_dir: config.cacheDir,
		});
		return {
			embed: async (text) => {
				const result: unknown = await extractor(text, { pooling: "mean", normalize: true });
				return property(result, "data") ?? result;
			},
			dispose: async () => {
				const dispose = method(extractor, "dispose");
				if (dispose !== undefined) await dispose();
			},
		};
	});
}

async function connectSubcSynapse(config: Readonly<SynapseConfig>): Promise<SynapseConnection> {
	const { SubcClient } = await import("@cortexkit/subc-client");
	const identity = {
		project_root: config.projectRoot,
		harness: "pi-ext-embed",
		session: config.session,
	};
	const client = await SubcClient.connect({ connectionFile: config.connectionFile, identity });
	return {
		call: async (method, params) => client.call("synapse", method, params, { identity }),
		close: () => client.close(),
	};
}

async function withCacheLock<T>(cacheDir: string, operation: () => Promise<T>): Promise<T> {
	await mkdir(cacheDir, { recursive: true });
	const lockPath = join(cacheDir, CACHE_LOCK_NAME);
	const deadline = Date.now() + CACHE_LOCK_WAIT_MS;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (handle === undefined) {
		try {
			handle = await open(lockPath, "wx");
			await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
		} catch (error: unknown) {
			if (!isAlreadyExists(error)) throw error;
			if (await staleLock(lockPath)) await rm(lockPath, { force: true });
			else if (Date.now() >= deadline)
				throw new Error("Timed out waiting for embedding cache lock");
			await delay(CACHE_LOCK_RETRY_MS);
		}
	}
	const heartbeat = setInterval(
		() => {
			void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
		},
		Math.floor(CACHE_LOCK_STALE_MS / 3),
	);
	try {
		return await operation();
	} finally {
		clearInterval(heartbeat);
		await handle.close().catch(() => undefined);
		await rm(lockPath, { force: true }).catch(() => undefined);
	}
}

async function staleLock(lockPath: string): Promise<boolean> {
	try {
		return Date.now() - (await stat(lockPath)).mtimeMs > CACHE_LOCK_STALE_MS;
	} catch {
		return false;
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function undefinedOnAbort<T>(
	work: Promise<T | undefined>,
	signal: AbortSignal,
): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolveResult) => {
		let settled = false;
		let abort: () => void = () => {};
		const finish = (result: T | undefined): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			resolveResult(result);
		};
		abort = (): void => finish(undefined);
		signal.addEventListener("abort", abort, { once: true });
		void work.then(finish);
	});
}

function requestConstraints(
	model: SynapseModel,
	purpose: EmbeddingPurpose,
	metadata: Readonly<Record<string, JsonScalar>> | undefined,
): Readonly<Record<string, unknown>> {
	return {
		model: model.model,
		required_fingerprint: model.fingerprint,
		required_epoch: model.epoch,
		allow_equivalent: false,
		accept_declared: false,
		// Synapse accepts an optional role hint, but identity constraints remain
		// the authority for model/lane selection.
		purpose,
		...(metadata === undefined ? {} : { metadata }),
	};
}

function modelFromList(response: unknown, requestedModel: string): SynapseModel | undefined {
	const models = Array.isArray(response) ? response : arrayProperty(response, "models");
	if (models === undefined) return undefined;
	for (const value of models) {
		if (!isRecord(value)) continue;
		const model = firstString(value, ["model", "id", "name"]);
		if (model !== requestedModel) continue;
		const fingerprint = readOptionalString(value, "fingerprint");
		const epoch = numberProperty(value, "table_epoch") ?? numberProperty(value, "epoch");
		const dimensions = numberProperty(value, "dims") ?? numberProperty(value, "dimensions");
		if (
			fingerprint === undefined ||
			epoch === undefined ||
			!Number.isInteger(epoch) ||
			epoch < 0 ||
			(dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1))
		)
			return undefined;
		return { model, fingerprint, epoch, ...(dimensions === undefined ? {} : { dimensions }) };
	}
	return undefined;
}

function vectorFromResponse(response: unknown): unknown {
	return property(response, "vector") ?? property(response, "embedding") ?? response;
}

function batchVectorsFromResponse(
	response: unknown,
	items: ReadonlyArray<{
		readonly id: string;
		readonly text: string;
		readonly contentHash: string;
	}>,
	dimensions: number | undefined,
): ReadonlyMap<string, Float32Array> | undefined {
	const values = arrayProperty(response, "items") ?? arrayProperty(response, "vectors");
	if (values === undefined || values.length !== items.length) return undefined;
	const expected = new Map(items.map((item) => [item.id, item]));
	const result = new Map<string, Float32Array>();
	for (const value of values) {
		if (!isRecord(value)) return undefined;
		const id = readOptionalString(value, "id");
		const contentHash =
			readOptionalString(value, "contentHash") ??
			readOptionalString(value, "content_hash") ??
			readOptionalString(value, "content_sha256");
		if (id === undefined || contentHash === undefined) return undefined;
		const expectedItem = expected.get(id);
		if (expectedItem === undefined || expectedItem.contentHash !== contentHash || result.has(id))
			return undefined;
		const vector = toVector(vectorFromResponse(value), dimensions);
		if (vector === undefined) return undefined;
		result.set(id, vector);
	}
	return result.size === items.length ? result : undefined;
}

function toVector(value: unknown, dimensions: number | undefined): Float32Array | undefined {
	const values =
		value instanceof Float32Array ? Array.from(value) : Array.isArray(value) ? value : undefined;
	if (
		values === undefined ||
		values.length === 0 ||
		(dimensions !== undefined && values.length !== dimensions)
	)
		return undefined;
	if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
	return new Float32Array(values);
}

function validateEmbedInput(text: unknown, purpose: unknown, signal: unknown): void {
	if (typeof text !== "string") throw new TypeError("Embedding text must be a string");
	if (purpose !== "query" && purpose !== "passage")
		throw new TypeError("Embedding purpose must be query or passage");
	if (!isAbortSignal(signal)) throw new TypeError("Embedding signal must be an AbortSignal");
}

function validateBatchInput(
	items: unknown,
	purpose: unknown,
	signal: unknown,
): asserts items is ReadonlyArray<{
	readonly id: string;
	readonly text: string;
	readonly contentHash: string;
}> {
	validateEmbedInput("", purpose, signal);
	if (!Array.isArray(items)) throw new TypeError("Embedding batch items must be an array");
	const seen = new Set<string>();
	for (const item of items) {
		if (!isRecord(item)) throw new TypeError("Embedding batch item must be an object");
		const id = readRequiredString(item, "id");
		if (seen.has(id)) throw new TypeError(`Duplicate embedding batch ID: ${id}`);
		seen.add(id);
		readRequiredString(item, "text");
		const contentHash = readRequiredString(item, "contentHash");
		if (!/^[a-fA-F0-9]{64}$/.test(contentHash))
			throw new TypeError("Embedding contentHash must be a SHA-256 hex digest");
	}
}

function readMetadata(value: unknown): Readonly<Record<string, JsonScalar>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new TypeError("Synapse metadata must be an object");
	const result: Record<string, JsonScalar> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key.trim().length === 0 || !isJsonScalar(item))
			throw new TypeError("Synapse metadata values must be finite strings, numbers, or booleans");
		result[key] = item;
	}
	return result;
}

function stableMetadata(metadata: Readonly<Record<string, JsonScalar>> | undefined): string {
	if (metadata === undefined) return "";
	return JSON.stringify(
		Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)),
	);
}

function assertKnownKeys(
	record: Readonly<Record<string, unknown>>,
	allowed: ReadonlyArray<string>,
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key))
			throw new TypeError(`Unknown embedding provider config key: ${key}`);
	}
}

function readRequiredString(record: Readonly<Record<string, unknown>>, key: string): string {
	const value = readOptionalString(record, key);
	if (value === undefined) throw new TypeError(`Embedding provider config requires ${key}`);
	return value;
}

function readOptionalString(
	record: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0)
		throw new TypeError(`Embedding provider config ${key} must be a non-empty string`);
	return value.trim();
}

function firstString(
	record: Readonly<Record<string, unknown>>,
	keys: ReadonlyArray<string>,
): string | undefined {
	for (const key of keys) {
		const value = readOptionalString(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

function numberProperty(
	record: Readonly<Record<string, unknown>>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayProperty(value: unknown, key: string): ReadonlyArray<unknown> | undefined {
	const candidate = property(value, key);
	return Array.isArray(candidate) ? candidate : undefined;
}

function property(value: unknown, key: string): unknown {
	if (isRecord(value)) return value[key];
	return typeof value === "function" ? Reflect.get(value, key) : undefined;
}

function method(value: unknown, key: string): (() => unknown) | undefined {
	const candidate = property(value, key);
	return typeof candidate === "function" ? () => Reflect.apply(candidate, value, []) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonScalar(value: unknown): value is JsonScalar {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		"aborted" in value &&
		typeof value.aborted === "boolean"
	);
}

function isAlreadyExists(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}
