/**
 * Argument conventions for slash commands whose arguments are whitespace-separated
 * subcommands: completion of the names, and the `verb` / `rest` split their handlers share.
 *
 * Pi hands `registerCommand(name, options)`'s `options.getArgumentCompletions(argumentPrefix)` to the
 * TUI completer. It triggers only for `/cmd <args>`, passes everything after the first space as
 * `argumentPrefix`, and replaces that whole argument text with the accepted `item.value`. This module
 * only matches names against that prefix; the subcommands, their arguments, and the command policy stay
 * with the concrete extension. Dynamic candidates (runtime ids, page ids) are the extension's own job.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type SubcommandCompletions = (argumentPrefix: string) => AutocompleteItem[] | null;

/**
 * Builds a `getArgumentCompletions` callback for a fixed subcommand list.
 *
 * A candidate may carry an argument of its own (`"view full"`). It only competes once the typed text
 * has reached its verb, which keeps verb-level completion unambiguous. Matching ignores case, mirroring
 * handlers that lowercase the verb themselves. The returned `value` is always the complete argument text
 * (`view full`), because the host replaces the whole argument rather than the last token; `label` shows
 * the newly completed token alone.
 */
export function subcommandCompletions(subcommands: readonly string[]): SubcommandCompletions {
	return (argumentPrefix) => {
		const text = argumentPrefix.trimStart().toLowerCase();
		const matched = subcommands.filter(
			(name) => name.startsWith(text) && (text.includes(" ") || !name.includes(" ")),
		);
		if (matched.length === 0) return null;
		return matched.map((name) => ({ value: name, label: name.slice(text.lastIndexOf(" ") + 1) }));
	};
}

/**
 * Splits `/cmd <verb> <rest>` argument text. The verb is lowercased, because completion and the
 * handlers both match case-insensitively; `rest` is empty when the command was given no argument.
 */
export function splitSubcommand(args: string): { readonly verb: string; readonly rest: string } {
	const input = args.trim();
	const separator = input.search(/\s/u);
	if (separator < 0) return { verb: input.toLowerCase(), rest: "" };
	return {
		verb: input.slice(0, separator).toLowerCase(),
		rest: input.slice(separator + 1).trim(),
	};
}
