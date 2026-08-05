/**
 * Parent-session registry for pi-subagents.
 *
 * Core owns child admission, turns, cancellation, and session disposal. This
 * module keeps only the extension's records, notifications, and worktree
 * policy around the opaque core conversation handle.
 */

import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ConversationReplyResult,
	type ConversationSubagentHandle,
	type ExtensionLifecycleContext,
	getService,
	PARENT_CONTEXT_PROJECTION_SERVICE,
	type SubagentEvent,
	startSubagent,
} from "@hheei/pi-ext-core";
import { buildParentContext } from "./context.js";
import { createCoreSessionFactory } from "./core-session.js";
import type { AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, type WorktreeInfo } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentChange = () => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_TURNS = 50;

export interface SpawnOptions {
	description: string;
	model?: Model<Api>;
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
	thinkingLevel?: ThinkingLevel;
	isBackground?: boolean;
	bypassQueue?: boolean;
	isolation?: IsolationMode;
	cwd?: string | null;
	configCwd?: string;
	invocation?: AgentRecord["invocation"];
	signal?: AbortSignal;
	onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
	onTextDelta?: (delta: string, fullText: string) => void;
	onSessionCreated?: (handle: ConversationSubagentHandle) => void;
	onTurnEnd?: (turnCount: number) => void;
	onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
	onCompaction?: (info: CompactionInfo) => void;
}

interface SpawnArgs {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly type: SubagentType;
	readonly prompt: string;
	readonly options: SpawnOptions;
}

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Operation aborted");
}

function statusForReply(
	record: AgentRecord,
	reply: ConversationReplyResult,
): AgentRecord["status"] {
	if (reply.status === "completed") return reply.softLimitReached ? "steered" : "completed";
	if (reply.status === "steered") return "steered";
	if (reply.status === "limit_reached") return "aborted";
	if (reply.status === "failed") return "error";
	return record.abortController?.signal.aborted === true ? "aborted" : "stopped";
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

export class AgentManager {
	private readonly agents = new Map<string, AgentRecord>();
	private maxConcurrent: number;
	private readonly onComplete: OnAgentComplete | undefined;
	private readonly onStart: OnAgentStart | undefined;
	private readonly onChange: OnAgentChange | undefined;
	private runtime: ExtensionLifecycleContext | undefined;

	constructor(
		onComplete?: OnAgentComplete,
		maxConcurrent = DEFAULT_MAX_CONCURRENT,
		onStart?: OnAgentStart,
		onChange?: OnAgentChange,
	) {
		this.onComplete = onComplete;
		this.maxConcurrent = Math.max(1, maxConcurrent);
		this.onStart = onStart;
		this.onChange = onChange;
	}

	/** Bind the current core lifecycle. A manager never outlives this scope. */
	setRuntime(runtime: ExtensionLifecycleContext): void {
		this.runtime = runtime;
	}

	getMaxConcurrent(): number {
		return this.maxConcurrent;
	}

	setMaxConcurrent(value: number): void {
		if (Number.isSafeInteger(value) && value > 0) this.maxConcurrent = value;
	}

	spawn(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		type: SubagentType,
		prompt: string,
		options: SpawnOptions,
	): string {
		const id = randomUUID().slice(0, 17);
		const abortController = new AbortController();
		const record: AgentRecord = {
			id,
			type,
			description: options.description,
			status: "queued",
			toolUses: 0,
			startedAt: Date.now(),
			abortController,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			compactionCount: 0,
			...(options.isBackground === undefined ? {} : { isBackground: options.isBackground }),
			...(options.invocation === undefined ? {} : { invocation: options.invocation }),
		};
		this.agents.set(id, record);
		this.onChange?.();
		try {
			const startup = this.startAgent(id, record, { pi, ctx, type, prompt, options });
			record.promise = startup.catch((error: unknown) => {
				const baseCwd = options.cwd ?? ctx.cwd;
				return this.fail(record, error, options, baseCwd);
			});
		} catch (error: unknown) {
			this.agents.delete(id);
			this.onChange?.();
			throw error;
		}
		return id;
	}

	private async startAgent(id: string, record: AgentRecord, args: SpawnArgs): Promise<string> {
		const runtime = this.runtime;
		if (runtime === undefined) throw new Error("Subagent runtime is not active");
		const { pi, ctx, type, prompt, options } = args;
		let initialMessage = prompt;
		if (options.inheritContext) {
			const service = getService(pi, PARENT_CONTEXT_PROJECTION_SERVICE);
			if (service === undefined) {
				initialMessage = buildParentContext(ctx) + prompt;
			} else {
				const result = await service.prepare({
					purpose: "inheritance",
					signal: options.signal ?? runtime.signal,
				});
				if (result.kind === "result") {
					if (result.purpose !== "inheritance" || typeof result.payload !== "string") {
						throw new Error("Invalid parent context projection result");
					}
					const taskHeader = "\n---\n# Your Task (below)\n";
					const hasTaskHeader = result.payload.endsWith("# Your Task (below)\n");
					initialMessage = hasTaskHeader
						? result.payload + prompt
						: result.payload + taskHeader + prompt;
				} else {
					initialMessage = buildParentContext(ctx) + prompt;
				}
			}
		}
		const baseCwd = options.cwd ?? ctx.cwd;
		let worktree: WorktreeInfo | undefined;
		if (options.isolation === "worktree") {
			worktree = createWorktree(baseCwd, id);
			if (worktree === undefined) {
				throw new Error(
					'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed.',
				);
			}
			record.worktree = worktree;
		}

		const childCwd = worktree === undefined ? options.cwd : worktree.workPath;
		const { cwd: _cwd, ...restOptions } = options;
		const childOptions = {
			...restOptions,
			pi,
			agentId: id,
			...(childCwd === null || childCwd === undefined ? {} : { cwd: childCwd }),
			configCwd: options.configCwd ?? ctx.cwd,
		};
		const handle = startSubagent(runtime, {
			mode: "conversation",
			session: createCoreSessionFactory(ctx, type, childOptions),
			initialMessage,
			initialReply: { kind: "wait", signal: new AbortController().signal },
			fallbackDelivery: async () => undefined,
			maxTurnsPerReply: Math.max(1, Math.floor(options.maxTurns ?? DEFAULT_MAX_TURNS)),
		});
		record.handle = handle;
		options.onSessionCreated?.(handle);
		const onParentAbort = () => {
			record.abortController?.abort(options.signal?.reason);
			handle.cancel();
		};
		if (options.signal !== undefined) {
			if (options.signal.aborted) onParentAbort();
			else options.signal.addEventListener("abort", onParentAbort, { once: true });
		}

		let lastText = "";
		let turnCount = 0;
		const subscription = handle.subscribe({
			kinds: new Set(["text", "tool", "turn", "terminal"]),
			signal: runtime.signal,
			onEvent: (event: SubagentEvent) => {
				this.handleEvent(record, event, options, (text) => {
					const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
					lastText = text;
					options.onTextDelta?.(delta, text);
				});
				if (event.kind === "turn") {
					if (event.state === "running" && record.status === "queued") {
						record.status = "running";
						this.onStart?.(record);
					}
					if (event.state === "idle") {
						turnCount += 1;
						options.onTurnEnd?.(turnCount);
					}
				}
			},
		});
		record.outputCleanup = () => {
			options.signal?.removeEventListener("abort", onParentAbort);
			subscription.dispose();
		};

		const initial = handle.initialReply;
		return await initial.then(
			(reply) => this.finish(record, reply, options, baseCwd),
			(error: unknown) => this.fail(record, error, options, baseCwd),
		);
	}

	private handleEvent(
		record: AgentRecord,
		event: SubagentEvent,
		options: SpawnOptions,
		onText: (text: string) => void,
	): void {
		if (event.kind === "text") {
			record.result = event.text;
			onText(event.text);
			return;
		}
		if (event.kind === "tool") {
			options.onToolActivity?.({ type: event.state, toolName: event.toolName });
			if (event.state === "end") record.toolUses += 1;
		}
	}

	private finish(
		record: AgentRecord,
		reply: ConversationReplyResult,
		options: SpawnOptions,
		baseCwd: string,
	): string {
		record.result = reply.output;
		record.status = statusForReply(record, reply);
		if (reply.failure === undefined) delete record.error;
		else record.error = reply.failure;
		record.completedAt = Date.now();
		this.updateUsage(record, options);
		this.cleanup(record, baseCwd);
		this.notifyComplete(record);
		return reply.output;
	}

	private fail(
		record: AgentRecord,
		error: unknown,
		options: SpawnOptions,
		baseCwd: string,
	): string {
		record.status = record.abortController?.signal.aborted === true ? "aborted" : "error";
		record.error = error instanceof Error ? error.message : String(error);
		record.completedAt = Date.now();
		this.updateUsage(record, options);
		this.cleanup(record, baseCwd);
		this.notifyComplete(record);
		return "";
	}

	private updateUsage(record: AgentRecord, options: SpawnOptions): void {
		const usage = record.handle?.usage();
		if (usage === undefined) return;
		const delta = {
			input: usage.input - record.lifetimeUsage.input,
			output: usage.output - record.lifetimeUsage.output,
			cacheWrite: 0,
		};
		addUsage(record.lifetimeUsage, delta);
		options.onAssistantUsage?.(delta);
	}

	private cleanup(record: AgentRecord, baseCwd: string): void {
		record.outputCleanup?.();
		delete record.outputCleanup;
		if (record.worktree !== undefined) {
			record.worktreeResult = cleanupWorktree(baseCwd, record.worktree, record.description);
		}
	}

	private notifyComplete(record: AgentRecord): void {
		try {
			this.onComplete?.(record);
		} catch {
			// Completion notification must not turn a settled child into a rejection.
		}
	}

	getRecord(id: string): AgentRecord | undefined {
		return this.agents.get(id);
	}

	listAgents(): AgentRecord[] {
		return [...this.agents.values()];
	}

	clearCompleted(includeConsumed = false): void {
		for (const [id, record] of this.agents) {
			if (record.completedAt === undefined) continue;
			if (!includeConsumed && record.resultConsumed === true) continue;
			record.handle?.cancel();
			this.agents.delete(id);
		}
	}

	async spawnAndWait(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		type: SubagentType,
		prompt: string,
		options: SpawnOptions,
		onSpawned?: (id: string) => void,
	): Promise<{ id: string; record: AgentRecord }> {
		const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
		onSpawned?.(id);
		const record = this.agents.get(id);
		if (record === undefined || record.promise === undefined)
			throw new Error("Subagent record disappeared");
		try {
			await record.promise;
		} finally {
			record.resultConsumed = true;
		}
		return { id, record };
	}

	async resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord> {
		const record = this.agents.get(id);
		if (record?.handle === undefined) throw new Error(`Agent not found: ${id}`);
		const handle = record.handle;
		record.status = "running";
		record.startedAt = Date.now();
		delete record.completedAt;
		delete record.result;
		delete record.error;
		const usageBefore = handle.usage();
		const subscription = handle.subscribe({
			kinds: new Set(["text", "tool"]),
			signal: new AbortController().signal,
			onEvent: (event) => {
				if (event.kind === "text") record.result = event.text;
				if (event.kind === "tool" && event.state === "end") record.toolUses += 1;
			},
		});
		const cancelOnAbort = (): void => handle.cancel();
		if (signal !== undefined) signal.addEventListener("abort", cancelOnAbort, { once: true });
		try {
			const result = await abortable(
				handle.send(prompt, {
					reply: { kind: "wait", signal: new AbortController().signal },
					inputMode: "queue",
				}),
				signal,
			);
			if (result.output) record.result = result.output;
			record.status = statusForReply(record, result);
			if (result.failure === undefined) delete record.error;
			else record.error = result.failure;
		} catch (error: unknown) {
			record.status = signal?.aborted === true ? "aborted" : "error";
			record.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (signal !== undefined) signal.removeEventListener("abort", cancelOnAbort);
			subscription.dispose();
			const usageAfter = handle.usage();
			addUsage(record.lifetimeUsage, {
				input: usageAfter.input - usageBefore.input,
				output: usageAfter.output - usageBefore.output,
				cacheWrite: 0,
			});
			record.completedAt = Date.now();
		}
		return record;
	}

	steer(id: string, message: string): boolean {
		const handle = this.agents.get(id)?.handle;
		if (handle === undefined) return false;
		void handle.steer(message).catch(() => undefined);
		return true;
	}

	abort(id: string): boolean {
		const record = this.agents.get(id);
		if (record?.handle === undefined) return false;
		record.abortController?.abort();
		record.handle.cancel();
		return true;
	}

	abortAll(): void {
		for (const record of this.agents.values()) {
			record.abortController?.abort();
			record.handle?.cancel();
		}
	}

	hasRunning(): boolean {
		return [...this.agents.values()].some((record) => record.completedAt === undefined);
	}

	async waitForAll(): Promise<void> {
		await Promise.all(
			[...this.agents.values()].map((record) => record.promise ?? Promise.resolve("")),
		);
	}

	dispose(): void {
		this.abortAll();
		for (const record of this.agents.values()) record.outputCleanup?.();
		this.agents.clear();
		this.runtime = undefined;
	}
}
