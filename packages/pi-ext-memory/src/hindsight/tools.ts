import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	isManagedLoadoutTool,
	type ManagedLoadoutToolRegistration,
	registerManagedLoadoutTool,
	setManagedLoadoutToolsActive,
} from "@hheei/pi-ext-core";
import { type HindsightGateway, KnowledgePagesUnavailableError } from "./client.js";
import type { ResolvedHindsight } from "./config.js";
import type { HindsightRetainQueue, HindsightRetainStatus } from "./queue.js";

export const HINDSIGHT_TOOL_NAMES = [
	"hindsight_search_knowledge_pages",
	"hindsight_list_knowledge_pages",
	"hindsight_read_knowledge_page",
	"hindsight_reflect",
	"hindsight_capture_initiative",
	"hindsight_ingest_document",
	"hindsight_sync_status",
	"hindsight_diagnose",
] as const;

export type HindsightToolName = (typeof HINDSIGHT_TOOL_NAMES)[number];

export const HINDSIGHT_TOOL_GROUP = "Hindsight Memory";
export const HINDSIGHT_TOOL_OWNER = "@hheei/pi-ext-memory";

/** Message returned whenever the deployment has no knowledge pages. */
export const KNOWLEDGE_PAGES_UNAVAILABLE_TEXT =
	"Knowledge pages are unavailable on this Hindsight server. Use hindsight_reflect for memory reasoning.";

/** Shown when a tool outlives the session that enabled it. */
export const HINDSIGHT_DISABLED_TEXT =
	"Hindsight long-term memory is disabled for this session; no memory was read or written.";

/** Upper bound on page hits returned by one search. */
export const SEARCH_PAGE_LIMIT = 5;
const DEFAULT_SEARCH_LIMIT = 3;

export interface HindsightToolDetails {
	readonly tool: HindsightToolName;
	readonly status: "ok" | "error" | "unavailable" | "disabled";
	readonly message?: string | undefined;
}

export interface HindsightDiagnoseDetails extends HindsightToolDetails {
	readonly bankId: string;
	readonly bankSource: string;
	readonly repo: string;
	readonly isolationMode: string;
	readonly scopeTags: readonly string[];
	readonly retainTags: readonly string[];
	readonly apiUrl: string;
	readonly tokenConfigured: boolean;
	readonly autoRecall: boolean;
	readonly retainSessions: boolean;
	readonly reachable: boolean;
	readonly pagesAvailable: boolean;
	readonly retain: HindsightRetainStatus;
}

/** Per-session state the tools read at call time. */
export interface HindsightToolContext {
	readonly gateway: HindsightGateway;
	readonly resolved: ResolvedHindsight;
	readonly retainQueue: HindsightRetainQueue;
}

/** Reads the current session's state; `undefined` while the feature is off. */
export type HindsightToolContextProvider = () => HindsightToolContext | undefined;

function textResult<TDetails extends HindsightToolDetails>(
	tool: HindsightToolName,
	status: TDetails["status"],
	text: string,
	extra?: Record<string, unknown>,
): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text" as const, text }],
		details: { tool, status, ...extra } as TDetails,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function registration(id: HindsightToolName): ManagedLoadoutToolRegistration {
	return {
		id,
		owner: HINDSIGHT_TOOL_OWNER,
		group: HINDSIGHT_TOOL_GROUP,
		origin: HINDSIGHT_TOOL_OWNER,
		priority: 100,
		conflictSets: [],
		defaultActive: true,
	};
}

/**
 * Registers the eight Hindsight tools.
 *
 * Registration happens once per Pi process, on the first session that enables the option,
 * because Pi rejects re-registering a managed tool from the same runner. Every call reads
 * its session state through `provider`, so a reload rebinds tools to the new session
 * instead of leaving them on a disposed one.
 *
 * A session with the option off never reaches this function, so a disabled configuration
 * registers nothing at all.
 */
export function registerHindsightTools(
	pi: ExtensionAPI,
	provider: HindsightToolContextProvider,
): void {
	async function withContext<TDetails extends HindsightToolDetails>(
		tool: HindsightToolName,
		run: (context: HindsightToolContext) => Promise<AgentToolResult<TDetails>>,
	): Promise<AgentToolResult<TDetails>> {
		const context = provider();
		if (context === undefined)
			return textResult<TDetails>(tool, "disabled", HINDSIGHT_DISABLED_TEXT);
		return run(context);
	}

	/**
	 * Runs one gateway operation, translating failures into a result the model can act on.
	 *
	 * Knowledge-page capability failures get the documented degradation message; everything
	 * else surfaces its own message, which is what a caller needs in order to decide
	 * whether to retry or fall back to `hindsight_reflect`.
	 */
	async function guarded<TDetails extends HindsightToolDetails>(
		tool: HindsightToolName,
		run: () => Promise<{ text: string }>,
	): Promise<AgentToolResult<TDetails>> {
		try {
			return textResult<TDetails>(tool, "ok", (await run()).text);
		} catch (error) {
			if (error instanceof KnowledgePagesUnavailableError) {
				return textResult<TDetails>(tool, "unavailable", KNOWLEDGE_PAGES_UNAVAILABLE_TEXT);
			}
			const message = errorMessage(error);
			return textResult<TDetails>(tool, "error", `${tool} failed: ${message}`, { message });
		}
	}

	const EmptyParams = Type.Object({});

	registerManagedLoadoutTool(
		pi,
		registration("hindsight_search_knowledge_pages"),
		defineTool({
			name: "hindsight_search_knowledge_pages",
			label: "Search Hindsight knowledge pages",
			description:
				"Search this repository's Hindsight knowledge pages (server-side hybrid full-text + semantic search). Use it for questions about architecture, conventions, components, or past decisions instead of re-deriving them from code. Returns ranked pages with a relevance snippet; read one in full with hindsight_read_knowledge_page.",
			parameters: Type.Object({
				query: Type.String({ description: "What to look for.", minLength: 1 }),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: SEARCH_PAGE_LIMIT, default: DEFAULT_SEARCH_LIMIT }),
				),
			}),
			async execute(_toolCallId, params, signal) {
				return withContext("hindsight_search_knowledge_pages", (context) =>
					guarded("hindsight_search_knowledge_pages", async () => {
						const hits = await context.gateway.searchPages(
							params.query,
							params.limit ?? DEFAULT_SEARCH_LIMIT,
							signal,
						);
						if (hits.length === 0) return { text: "No matching knowledge pages." };
						return {
							text: hits
								.map(
									(hit) =>
										`${hit.page} (${hit.pageId}, score ${hit.score.toFixed(2)})\n  ${hit.snippet}`,
								)
								.join("\n"),
						};
					}),
				);
			},
		}),
	);

	registerManagedLoadoutTool(
		pi,
		registration("hindsight_list_knowledge_pages"),
		defineTool({
			name: "hindsight_list_knowledge_pages",
			label: "List Hindsight knowledge pages",
			description:
				"List this repository's Hindsight knowledge pages — curated summaries of durable project knowledge (architecture, components, conventions, decisions, in-flight initiatives). Call it at the start of a non-trivial task to see what the project already knows.",
			parameters: EmptyParams,
			async execute(_toolCallId, _params, signal) {
				return withContext("hindsight_list_knowledge_pages", (context) =>
					guarded("hindsight_list_knowledge_pages", async () => {
						const { pages, pagesAvailable } = await context.gateway.listPages(signal);
						if (!pagesAvailable) throw new KnowledgePagesUnavailableError();
						if (pages.length === 0)
							return { text: "No knowledge pages exist for this repository yet." };
						return {
							text: pages
								.map((page) =>
									page.description === undefined || page.description.length === 0
										? `${page.id} — ${page.title}`
										: `${page.id} — ${page.title}: ${page.description}`,
								)
								.join("\n"),
						};
					}),
				);
			},
		}),
	);

	registerManagedLoadoutTool(
		pi,
		registration("hindsight_read_knowledge_page"),
		defineTool({
			name: "hindsight_read_knowledge_page",
			label: "Read a Hindsight knowledge page",
			description:
				"Read one knowledge page in full by id. Read Conventions before writing code, Component map before changing a subsystem, or an initiative's page before continuing that feature. A page may link related pages with [[page:<id>]]; follow a link by calling this tool again.",
			parameters: Type.Object({
				page_id: Type.String({
					description: "Knowledge page id from hindsight_list_knowledge_pages.",
					minLength: 1,
				}),
			}),
			async execute(_toolCallId, params, signal) {
				return withContext("hindsight_read_knowledge_page", (context) =>
					guarded("hindsight_read_knowledge_page", async () => {
						const page = await context.gateway.readPage(params.page_id, signal);
						return { text: `# ${page.title}\n\n${page.markdown}` };
					}),
				);
			},
		}),
	);

	registerManagedLoadoutTool(
		pi,
		registration("hindsight_reflect"),
		defineTool({
			name: "hindsight_reflect",
			label: "Reflect over Hindsight memory",
			description:
				"Deep memory reasoning: an agentic synthesis over this repository's full memory (git decisions, past sessions, ingested knowledge) that answers WHY questions — the decision and exact rule or values behind a behavior, bug, or convention. Slower than page search (several seconds); use it when pages are too shallow and you need the root cause.",
			parameters: Type.Object({
				query: Type.String({
					description: "The question to reason over memory about.",
					minLength: 1,
				}),
			}),
			async execute(_toolCallId, params, signal) {
				return withContext("hindsight_reflect", (context) =>
					guarded("hindsight_reflect", async () => {
						const text = await context.gateway.reflect(params.query, signal);
						return {
							text: text.trim().length === 0 ? "No memory-based answer was produced." : text,
						};
					}),
				);
			},
		}),
	);

	registerManagedLoadoutTool(
		pi,
		registration("hindsight_capture_initiative"),
		defineTool({
			name: "hindsight_capture_initiative",
			label: "Capture a Hindsight initiative",
			description:
				"Record a new feature or initiative as a tracked knowledge page so future sessions know it exists, and keep that page tracking the plan as it moves. Call it right after the user approves a plan and before writing code; call it again with relates_to_page_id when the goal, scope, or rationale materially changes. Skip bug fixes, small tweaks, refactors, and chores.",
			parameters: Type.Object({
				title: Type.String({ description: "Short, specific initiative name.", minLength: 1 }),
				summary: Type.String({
					description: "2-3 sentences on what is being built and why — the current intent.",
					minLength: 1,
				}),
				relates_to_page_id: Type.Optional(
					Type.String({
						description:
							"Existing initiative page id, to record a plan change instead of creating a second page.",
					}),
				),
			}),
			async execute(_toolCallId, params, signal) {
				return withContext("hindsight_capture_initiative", (context) =>
					guarded("hindsight_capture_initiative", async () => {
						const { pageId } = await context.gateway.captureInitiative(
							{
								title: params.title,
								summary: params.summary,
								...(params.relates_to_page_id === undefined
									? {}
									: { relatesToPageId: params.relates_to_page_id }),
							},
							signal,
						);
						return { text: `Initiative recorded on knowledge page ${pageId}.` };
					}),
				);
			},
		}),
	);

	registerManagedLoadoutTool(
		pi,
		registration("hindsight_ingest_document"),
		defineTool({
			name: "hindsight_ingest_document",
			label: "Ingest a document into Hindsight",
			description:
				"Save an external document or a block of durable notes into this repository's memory so it informs future recall and knowledge pages. This is also the correction mechanism: when a retrieved memory is wrong or outdated, ingest a document titled 'Correction: <topic>' stating what memory claimed, what is actually true, and the evidence. The conversation you are in is captured automatically at turn end — do not use this for it.",
			parameters: Type.Object({
				title: Type.String({
					description: "Document title; use 'Correction: <topic>' to correct memory.",
					minLength: 1,
				}),
				content: Type.String({ description: "The durable content to remember.", minLength: 1 }),
			}),
			async execute(_toolCallId, params, signal) {
				return withContext("hindsight_ingest_document", (context) =>
					guarded("hindsight_ingest_document", async () => {
						const { documentId } = await context.gateway.ingestDocument(
							{ title: params.title, content: params.content },
							signal,
						);
						return { text: `Document stored as ${documentId}.` };
					}),
				);
			},
		}),
	);

	registerManagedLoadoutTool(
		pi,
		registration("hindsight_sync_status"),
		defineTool({
			name: "hindsight_sync_status",
			label: "Check Hindsight sync status",
			description:
				"Report whether this repository's Hindsight memory is reachable and how much it holds: server API version, knowledge-page availability and count, and stored document total.",
			parameters: EmptyParams,
			async execute(_toolCallId, _params, signal) {
				return withContext("hindsight_sync_status", (context) =>
					guarded("hindsight_sync_status", async () => {
						const status = await context.gateway.syncStatus(signal);
						return {
							text: [
								`Server API version: ${status.apiVersion ?? "unknown"}`,
								status.pagesAvailable
									? `Knowledge pages: ${status.pageCount}`
									: "Knowledge pages: unavailable on this server",
								`Stored documents: ${status.documentTotal}`,
							].join("\n"),
						};
					}),
				);
			},
		}),
	);

	registerManagedLoadoutTool(
		pi,
		registration("hindsight_diagnose"),
		defineTool({
			name: "hindsight_diagnose",
			label: "Diagnose Hindsight configuration",
			description:
				"Report the effective Hindsight configuration: resolved bank and how it was chosen, repository isolation mode and scope tags, endpoint, whether a token is configured (never its value), reachability, and pending writeback state. Use it when memory looks wrong or facts from another repository appear.",
			parameters: EmptyParams,
			async execute(_toolCallId, _params, signal) {
				return withContext("hindsight_diagnose", async (context) => {
					const retain = context.retainQueue.status();
					let reachable = true;
					let pagesAvailable = true;
					try {
						pagesAvailable = (await context.gateway.listPages(signal)).pagesAvailable;
					} catch {
						reachable = false;
					}
					const { config, bankId, bankSource, isolationMode, repo, scopeTags, retainTags } =
						context.resolved;
					const details: HindsightDiagnoseDetails = {
						tool: "hindsight_diagnose",
						status: reachable ? "ok" : "error",
						bankId,
						bankSource,
						repo,
						isolationMode,
						scopeTags,
						retainTags,
						apiUrl: config.apiUrl,
						tokenConfigured: config.apiToken !== undefined,
						autoRecall: config.autoRecall,
						retainSessions: config.retainSessions,
						reachable,
						pagesAvailable,
						retain,
						...(reachable ? {} : { message: "Hindsight server not reachable" }),
					};
					return {
						content: [
							{
								type: "text" as const,
								text: [
									`Endpoint: ${config.apiUrl}`,
									`Token configured: ${details.tokenConfigured ? "yes" : "no"}`,
									`Bank: ${bankId} (chosen by ${bankSource})`,
									`Repository: ${repo}`,
									`Isolation: ${isolationMode}${scopeTags.length > 0 ? ` (scope tags: ${scopeTags.join(", ")})` : ""}`,
									`Retain tags: ${retainTags.length > 0 ? retainTags.join(", ") : "none"}`,
									`Server reachable: ${reachable ? "yes" : "no"}`,
									`Knowledge pages available: ${pagesAvailable ? "yes" : "no"}`,
									`Auto-recall before turns: ${config.autoRecall ? "on" : "off"}`,
									`Session writeback: ${config.retainSessions ? "on" : "off"}`,
									`Writeback state: ${retain.retainedTurns} turns retained, ${retain.pendingBatches} pending batches, ${retain.inFlight ? "in flight" : "idle"}`,
									...(retain.lastError === undefined
										? []
										: [`Last writeback error: ${retain.lastError}`]),
								].join("\n"),
							},
						],
						details,
					};
				});
			},
		}),
	);
}

/** Whether every Hindsight tool is already registered in this Pi process. */
export function hindsightToolsRegistered(pi: ExtensionAPI): boolean {
	return HINDSIGHT_TOOL_NAMES.every((id) => isManagedLoadoutTool(pi, id));
}

/**
 * Enables or disables the Hindsight tool set for the current lifecycle.
 *
 * Registration happens once, so a later session with the option turned off deactivates the
 * existing tools: a tool whose server is no longer configured is worse than no tool.
 */
export function setHindsightToolsActive(context: ExtensionLifecycleContext, active: boolean): void {
	if (!hindsightToolsRegistered(context.pi)) return;
	setManagedLoadoutToolsActive(
		context,
		HINDSIGHT_TOOL_NAMES.map((id) => registration(id)),
		active,
	);
}
