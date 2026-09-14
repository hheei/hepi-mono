import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentMemoryClientPort, ObserveInput, ObserveResult } from "./client";
import type { AgentMemoryIdentity } from "./project";

export type AgentMemorySessionContext = {
	cwd: string;
	sessionManager?:
		| {
				getSessionId?: () => string | undefined;
				getSessionFile?: () => string | undefined;
		  }
		| undefined;
};

export type AgentMemorySessionBinding = {
	piSessionId: string;
	remoteSessionId: string;
	project: string;
	agentId?: string | undefined;
	cwd: string;
	ended: boolean;
};

export type AgentMemorySessionManagerOptions = {
	client: AgentMemoryClientPort;
	resolveIdentity: (cwd: string) => AgentMemoryIdentity;
	enabled: () => boolean;
	onFailure?: ((operation: string, error: unknown) => void) | undefined;
	onSuccess?: ((operation: string) => void) | undefined;
	activationId?: string | undefined;
};

export function resolvePiSessionId(context: AgentMemorySessionContext): string {
	const sessionId = context.sessionManager?.getSessionId?.()?.trim();
	if (sessionId) return sessionId;
	const sessionFile = context.sessionManager?.getSessionFile?.()?.trim();
	if (sessionFile) return basename(sessionFile).replace(/\.[^.]+$/, "") || "ephemeral-unknown";
	return "ephemeral-unknown";
}

export class AgentMemorySessionManager {
	readonly #client: AgentMemoryClientPort;
	readonly #resolveIdentity: (cwd: string) => AgentMemoryIdentity;
	readonly #enabled: () => boolean;
	readonly #onFailure: ((operation: string, error: unknown) => void) | undefined;
	readonly #onSuccess: ((operation: string) => void) | undefined;
	readonly #activationId: string;
	readonly #bindings = new Map<string, AgentMemorySessionBinding>();
	readonly #starting = new Map<string, Promise<AgentMemorySessionBinding | undefined>>();
	readonly #observing = new Set<Promise<ObserveResult | undefined>>();
	readonly #lifetime = new AbortController();
	#shuttingDown = false;
	#shutdownPromise: Promise<void> | undefined;

	constructor(options: AgentMemorySessionManagerOptions) {
		this.#client = options.client;
		this.#resolveIdentity = options.resolveIdentity;
		this.#enabled = options.enabled;
		this.#onFailure = options.onFailure;
		this.#onSuccess = options.onSuccess;
		this.#activationId = options.activationId?.trim() || `pi-${randomUUID()}`;
	}

	get bindings(): readonly AgentMemorySessionBinding[] {
		return [...this.#bindings.values()].map((binding) => ({ ...binding }));
	}

	getBinding(piSessionId: string): AgentMemorySessionBinding | undefined {
		const binding = this.#bindings.get(piSessionId);
		return binding ? { ...binding } : undefined;
	}

	async startForContext(
		context: AgentMemorySessionContext,
	): Promise<AgentMemorySessionBinding | undefined> {
		if (this.#shuttingDown || !this.#enabled()) return undefined;
		const piSessionId = resolvePiSessionId(context);
		const existing = this.#bindings.get(piSessionId);
		if (existing && !existing.ended) return { ...existing };
		const current = this.#starting.get(piSessionId);
		if (current) return current;
		const pending = this.#start(piSessionId, context);
		this.#starting.set(piSessionId, pending);
		try {
			return await pending;
		} finally {
			if (this.#starting.get(piSessionId) === pending) this.#starting.delete(piSessionId);
		}
	}

	observeForContext(
		context: AgentMemorySessionContext,
		input: Omit<ObserveInput, "sessionId" | "project">,
	): Promise<ObserveResult | undefined> {
		if (this.#shuttingDown || !this.#enabled()) return Promise.resolve(undefined);
		const pending = this.#observe(context, input);
		this.#observing.add(pending);
		void pending.finally(() => this.#observing.delete(pending));
		return pending;
	}

	shutdown(): Promise<void> {
		this.#shutdownPromise ??= this.#finishShutdown();
		return this.#shutdownPromise;
	}

	async #finishShutdown(): Promise<void> {
		this.#shuttingDown = true;
		this.#lifetime.abort();
		await Promise.allSettled([...this.#starting.values(), ...this.#observing]);
		const live = [...this.#bindings.values()].filter((binding) => !binding.ended);
		await Promise.allSettled(live.map((binding) => this.#end(binding)));
	}

	async #start(
		piSessionId: string,
		context: AgentMemorySessionContext,
	): Promise<AgentMemorySessionBinding | undefined> {
		try {
			await this.#client.health({ signal: this.#lifetime.signal });
			this.#reportSuccess("health");
		} catch (error) {
			if (!this.#shuttingDown) this.#reportFailure("health", error);
			return undefined;
		}
		try {
			const identity = this.#resolveIdentity(context.cwd);
			const proposedSessionId = `${this.#activationId}:${randomUUID()}`;
			const result = await this.#client.startSession(
				{
					sessionId: proposedSessionId,
					project: identity.project,
					cwd: context.cwd,
					...(identity.agentId ? { agentId: identity.agentId } : {}),
				},
				{ signal: this.#lifetime.signal },
			);
			this.#reportSuccess("session/start");
			if (this.#shuttingDown) {
				await this.#client.endSession(result.sessionId).catch((error: unknown) => {
					this.#reportFailure("session/end", error);
				});
				return undefined;
			}
			const binding: AgentMemorySessionBinding = {
				piSessionId,
				remoteSessionId: result.sessionId,
				project: identity.project,
				cwd: context.cwd,
				ended: false,
				...(identity.agentId ? { agentId: identity.agentId } : {}),
			};
			this.#bindings.set(piSessionId, binding);
			return { ...binding };
		} catch (error) {
			if (!this.#shuttingDown) this.#reportFailure("session/start", error);
			return undefined;
		}
	}

	async #observe(
		context: AgentMemorySessionContext,
		input: Omit<ObserveInput, "sessionId" | "project">,
	): Promise<ObserveResult | undefined> {
		const binding = await this.startForContext(context);
		if (!binding || binding.ended || this.#shuttingDown) return undefined;
		try {
			const result = await this.#client.observe(
				{
					...input,
					cwd: input.cwd ?? binding.cwd,
					sessionId: binding.remoteSessionId,
					project: binding.project,
				},
				{ signal: this.#lifetime.signal },
			);
			this.#reportSuccess("observe");
			return result;
		} catch (error) {
			if (!this.#shuttingDown) this.#reportFailure("observe", error);
			return undefined;
		}
	}

	async #end(binding: AgentMemorySessionBinding): Promise<void> {
		const current = this.#bindings.get(binding.piSessionId);
		if (!current || current.ended) return;
		current.ended = true;
		try {
			await this.#client.endSession(current.remoteSessionId);
			this.#reportSuccess("session/end");
		} catch (error) {
			this.#reportFailure("session/end", error);
		}
	}

	#reportSuccess(operation: string): void {
		try {
			this.#onSuccess?.(operation);
		} catch {
			// Observability cannot become a runtime dependency.
		}
	}

	#reportFailure(operation: string, error: unknown): void {
		try {
			this.#onFailure?.(operation, error);
		} catch {
			// Observability cannot become a runtime dependency.
		}
	}
}
