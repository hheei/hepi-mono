/**
 * Feature-neutral argument completion for slash commands whose arguments are
 * whitespace-separated subcommands.
 *
 * Pi hands `registerCommand(name, options)`'s `options.getArgumentCompletions(argumentPrefix)` to the
 * TUI completer. It triggers only for `/cmd <args>`, passes everything after the first space as
 * `argumentPrefix`, and replaces that whole argument text with the accepted `item.value`. This module
 * only matches names against that prefix; the subcommands, their arguments, and the command policy stay
 * with the concrete extension. Dynamic candidates (runtime ids, page ids) are the extension's own job.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type SubcommandCompletionsOptions = {
	/**
	 * Fixed argument names per subcommand, for subcommands that take one. A subcommand
	 * missing here completes nothing beyond its own name.
	 */
	readonly args?: Readonly<Record<string, readonly string[]>>;
};

export type SubcommandCompletions = (argumentPrefix: string) => AutocompleteItem[] | null;

/**
 * Builds a `getArgumentCompletions` callback for a fixed subcommand list.
 *
 * Matching ignores case, mirroring handlers that lowercase the verb themselves. The returned `value` is
 * always the complete argument text (`view full`), because the host replaces the whole argument rather
 * than the last token; `label` shows the newly completed token alone.
 */
export function subcommandCompletions(
	subcommands: readonly string[],
	options: SubcommandCompletionsOptions = {},
): SubcommandCompletions {
	return (argumentPrefix) => {
		const text = argumentPrefix.trimStart();
		const separator = text.search(/\s/u);
		if (separator < 0) return matchSubcommands(text, subcommands, (name) => name);
		const verb = text.slice(0, separator);
		const args = options.args?.[verb.toLowerCase()];
		if (args === undefined) return null;
		const rest = text.slice(separator + 1).trimStart();
		return matchSubcommands(rest, args, (name) => `${verb} ${name}`);
	};
}

function matchSubcommands(
	prefix: string,
	names: readonly string[],
	toValue: (name: string) => string,
): AutocompleteItem[] | null {
	const needle = prefix.toLowerCase();
	const matched = names.filter((name) => name.toLowerCase().startsWith(needle));
	if (matched.length === 0) return null;
	return matched.map((name) => ({ value: toValue(name), label: name }));
}
