import { expect, test } from "bun:test";
import { getToolResultLayout } from "../src/index.js";

const tui = {
	terminal: { write: (): void => {} },
	addInputListener: (): (() => void) => (): void => {},
	requestRender: (): void => {},
} as never;
const bounds = { x: 1, y: 2, width: 30, height: 4 };

test("returns undefined when result layout capability is absent or malformed", () => {
	expect(getToolResultLayout(undefined)).toBeUndefined();
	expect(getToolResultLayout({})).toBeUndefined();
	expect(getToolResultLayout({ resultLayout: undefined })).toBeUndefined();
	expect(
		getToolResultLayout({ resultLayout: { tui: null, onChange: () => undefined } }),
	).toBeUndefined();
	expect(getToolResultLayout({ resultLayout: { tui, onChange: undefined } })).toBeUndefined();
});

test("normalizes bounds notifications and disposes subscription once", () => {
	let notify: ((value: unknown) => void) | undefined;
	let disposeCount = 0;
	const layout = getToolResultLayout({
		resultLayout: {
			tui,
			bounds,
			onChange(listener: (value: unknown) => void) {
				notify = listener;
				return () => {
					disposeCount += 1;
				};
			},
		},
	});

	expect(layout?.bounds).toEqual(bounds);
	const received: unknown[] = [];
	const dispose = layout?.onChange((value) => received.push(value));
	notify?.(bounds);
	notify?.({ x: 0, y: 0, width: Number.NaN, height: 1 });
	expect(received).toEqual([bounds, undefined]);
	dispose?.();
	dispose?.();
	expect(disposeCount).toBe(1);
});
