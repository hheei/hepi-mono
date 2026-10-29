import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";

const MARK = "\u0000";
/** Any SGR sequence: parameters are `;`-separated, an empty parameter list means reset. */
const SGR = /\x1b\[([0-9;]*)m/g;

/**
 * Paint one surface's rows. A surface owns its own background and nothing else: after any reset
 * (`0`, `49`, or a compound sequence containing one) it re-asserts *its* background, so a row keeps
 * the fill across the styled spans a theme or child renderer ends with `\x1b[0m`.
 *
 * It never guesses another surface's background. A nested surface that ended its own fill is gone;
 * the rest of the row belongs to the surface painting it. Nested surfaces stay separate because each
 * one paints the rows it draws, not because this function tracks ANSI state.
 */
export function backgroundFill(theme: Theme, token: ThemeBg): (text: string) => string {
	const [start, end] = theme.bg(token, MARK).split(MARK);
	if (start === undefined || end === undefined) return (text) => text;
	return (text) => {
		let out = start;
		let from = 0;
		for (const match of text.matchAll(SGR)) {
			const params = match[1] ?? "";
			const resets =
				params === "" || params.split(";").some((code) => code === "0" || code === "49");
			const next = (match.index ?? 0) + match[0].length;
			out += text.slice(from, next);
			if (resets) out += start;
			from = next;
		}
		return `${out}${text.slice(from)}${end}`;
	};
}
