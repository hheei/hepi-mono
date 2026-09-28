import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Fits one rendered row to a width, reusing the result for a repeated `(text, width)` pair.
 *
 * Pi re-renders every mounted component on every frame and on every keystroke, while
 * `truncateToWidth` walks `Intl.Segmenter` graphemes (measured ~4-6us) for any row carrying ANSI
 * styling or non-ASCII characters, which is every styled row. The settings page, the loadout page,
 * the footer and the page router tabs therefore rebuild the same rows on every frame, so fitting the
 * same row twice is pure waste. Keying by the rendered text keeps theme changes correct, because the
 * colors are part of the key. Keeps the newest `CACHE_LIMIT` entries, oldest first.
 */
const CACHE_LIMIT = 1024;
const cache = new Map<string, string>();

export function fitRow(text: string, width: number, ellipsis?: string): string {
	if (width <= 0) return "";
	const key =
		ellipsis === undefined ? `${width}\u0000${text}` : `${width}\u0000${ellipsis}\u0000${text}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const fitted =
		ellipsis === undefined ? truncateToWidth(text, width) : truncateToWidth(text, width, ellipsis);
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, fitted);
	return fitted;
}
