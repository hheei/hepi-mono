import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const DEFAULT_LIMIT = 8;
const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Describe the task that needs a tool." }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum matches. Defaults to ${DEFAULT_LIMIT}.` }),
	),
});

type SearchInput = Static<typeof toolSearchSchema>;
type ToolAccess = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
type SearchableTool = Pick<ToolInfo, "name" | "description" | "namespace">;

interface SearchDocument {
	tool: SearchableTool;
	terms: string[];
}

interface SearchMatch {
	tool: SearchableTool;
	score: number;
}

function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

function searchText(tool: SearchableTool): string {
	return [
		tool.name,
		tool.name.replaceAll("_", " "),
		tool.description,
		tool.namespace?.name,
		tool.namespace?.description,
		tool.namespace?.instructions,
	]
		.filter((part): part is string => part !== undefined && part.trim() !== "")
		.join(" ");
}

function rank(query: string, tools: readonly SearchableTool[], limit: number): SearchMatch[] {
	const queryTerms = [...new Set(tokenize(query))];
	if (queryTerms.length === 0 || tools.length === 0) return [];
	const documents: SearchDocument[] = tools.map((tool) => ({
		tool,
		terms: tokenize(searchText(tool)),
	}));
	const averageLength =
		documents.reduce((sum, document) => sum + document.terms.length, 0) / documents.length || 1;
	const idf = new Map(
		queryTerms.map((term) => {
			const frequency = documents.filter((document) => document.terms.includes(term)).length;
			return [
				term,
				Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5)),
			] as const;
		}),
	);
	const matches: SearchMatch[] = [];
	for (const document of documents) {
		let score = 0;
		for (const term of queryTerms) {
			const count = document.terms.filter((candidate) => candidate === term).length;
			if (count === 0) continue;
			const norm = 1.2 * (0.25 + (0.75 * document.terms.length) / averageLength);
			score += (idf.get(term) ?? 0) * ((count * 2.2) / (count + norm));
		}
		if (score > 0) matches.push({ tool: document.tool, score });
	}
	return matches.sort((left, right) => right.score - left.score).slice(0, limit);
}

function isSearchable(tool: ToolInfo): boolean {
	return tool.exposure === "codemode" || tool.exposure === "deferred";
}

function conciseDescription(description: string): string {
	return description.trim().split(/\r?\n/)[0] ?? "";
}

function isDefinitionLookup(query: string): boolean {
	return (
		/\b(?:look up|lookup|show|give|provide|get|what(?:'s| is))\b/i.test(query) &&
		/\b(?:definition|schema|parameters?|arguments?|signature)\b/i.test(query)
	);
}

function searchAndLoad(
	tools: ToolAccess,
	query: string,
	limit: number,
): { loaded: SearchableTool[]; alreadyAvailable: SearchableTool[] } {
	const active = tools.getActiveTools();
	const matches = rank(query, tools.getAllTools().filter(isSearchable), limit).map(
		({ tool }) => tool,
	);
	const loaded = matches.filter((tool) => !active.includes(tool.name));
	const alreadyAvailable = matches.filter((tool) => active.includes(tool.name));
	if (loaded.length > 0) tools.setActiveTools([...active, ...loaded.map((tool) => tool.name)]);
	return { loaded, alreadyAvailable };
}

export function createToolSearchToolDefinition(
	tools: ToolAccess,
): ToolDefinition<typeof toolSearchSchema, { loaded: string[]; alreadyAvailable: string[] }> {
	return {
		name: "tool_search",
		label: "tool_search",
		description:
			"Search tool names and descriptions for the current task. Matching tools are loaded for the next model call; already available tools are reported as such. This tool does not return parameter schemas.",
		promptSnippet: "Find and load tools needed for the current task",
		parameters: toolSearchSchema,
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",
		reachesTools: () => "all",
		async execute(_toolCallId, { query, limit }: SearchInput) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			if (isDefinitionLookup(query)) {
				return {
					content: [
						{
							type: "text",
							text: "tool_search finds tools for a task; it does not look up tool definitions. Describe the task that needs a tool.",
						},
					],
					details: { loaded: [], alreadyAvailable: [] },
				};
			}
			const { loaded, alreadyAvailable } = searchAndLoad(tools, query, max);
			const sections = [
				loaded.length === 0
					? undefined
					: "Loaded for next call:\n" +
						loaded
							.map((tool) => `- ${tool.name}: ${conciseDescription(tool.description)}`)
							.join("\n"),
				alreadyAvailable.length === 0
					? undefined
					: `loaded: ${alreadyAvailable.map((tool) => tool.name).join(", ")}`,
			].filter((section): section is string => section !== undefined);
			const text = sections.length > 0 ? sections.join("\n") : "No matching tools found.";
			return {
				content: [{ type: "text", text }],
				details: {
					loaded: loaded.map((tool) => tool.name),
					alreadyAvailable: alreadyAvailable.map((tool) => tool.name),
				},
			};
		},
	};
}
