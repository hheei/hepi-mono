import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Pi re-renders every mounted component on every frame, and `truncateToWidth` walks
 * `Intl.Segmenter` graphemes (measured ~4-6us) for any row carrying ANSI styling or
 * non-ASCII characters, which is every styled row. Both settings pages rebuild the
 * same rows on each frame and on every keystroke, so fitting the same `(text, width)`
 * pair twice is pure waste. Keeps the newest `CACHE_LIMIT` entries, oldest first.
 */
const CACHE_LIMIT = 1024;
const cache = new Map<string, string>();

export function fitRow(text: string, width: number): string {
	if (width <= 0) return "";
	const key = `${width}\u0000${text}`;
	const cached = cache.get(key);
	if (cached !== undefined) {
		cache.delete(key);
		cache.set(key, cached);
		return cached;
	}
	const fitted = truncateToWidth(text, width);
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, fitted);
	return fitted;
}
