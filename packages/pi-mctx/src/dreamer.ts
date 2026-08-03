/** Upper bound for the Dreamer report body notified to the user. */
export const DREAMER_REPORT_CHARS = 4_000;

export const DREAMER_SYSTEM_PROMPT = `You are the Dreamer evaluator for the parent MCTX session. You evaluate smart-condition notes against the current project context.
Rules:
- Use only these tools: read, grep, find, ls, ctx_search.
- ctx_search searches bounded project memories, notes, retained history, Git commits, and optional primer text. Use it first.
- read/grep/find/ls explore repository files only when a condition needs facts the search does not cover.
- Never modify anything. Never use any other tool.
- Output only the evaluation report: one line per note (note id, SATISFIED or NOT SATISFIED, and a short evidence citation). No preamble, no markdown fences.`;

/** Minimal note shape compiled into the Dreamer prompt (feature layer passes a Pick). */
export interface DreamerNoteInput {
	readonly noteId: number;
	readonly content: string;
	readonly smartCondition?: string;
}

/** Builds the Dreamer task prompt from pending smart-condition notes and an optional query. */
export function buildDreamerPrompt(
	notes: readonly DreamerNoteInput[],
	query: string | undefined,
): string {
	const lines = notes.map(
		(note) =>
			`- #${note.noteId} [${note.content.slice(0, 200)}] — condition: ${
				note.smartCondition ?? "(none)"
			}`,
	);
	return [
		"Evaluate the following smart-condition notes against the current project context.",
		"For each note, determine whether its condition currently holds and cite the evidence you found.",
		"",
		"Notes:",
		...lines,
		...(query === undefined ? [] : ["", `Additional focus from the user: ${query}`]),
		"",
		"Return one concise report: one line per note (id, SATISFIED or NOT SATISFIED, evidence).",
	].join("\n");
}
