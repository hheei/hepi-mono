import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openTuiSurface, TuiSurfaceQueueFullError } from "../src/index.js";

type ActiveSurface = {
	readonly close: (
		value: { readonly status: "closed"; readonly value: string } | { readonly status: "aborted" },
	) => void;
};

function fixture(): {
	readonly pi: ExtensionAPI;
	readonly command: ExtensionCommandContext;
	readonly active: readonly ActiveSurface[];
	readonly customCalls: () => number;
} {
	const active: ActiveSurface[] = [];
	let calls = 0;
	const events = {};
	const pi = { events } as unknown as ExtensionAPI;
	const command = {
		mode: "tui",
		ui: {
			custom<T>(
				factory: (
					tui: never,
					theme: never,
					keybindings: never,
					done: (value: T) => void,
				) => unknown,
			): Promise<T> {
				calls++;
				return new Promise<T>((resolve) => {
					factory(undefined as never, undefined as never, undefined as never, (value) => {
						active.push({ close: value as never });
						resolve(value);
					});
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	return { pi, command, active, customCalls: () => calls };
}

test("opens queued custom surfaces in FIFO order", async () => {
	const h = fixture();
	const firstController = new AbortController();
	const secondController = new AbortController();
	let firstClose: ((value: string) => void) | undefined;
	let secondClose: ((value: string) => void) | undefined;
	const first = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: firstController.signal,
		maxPending: 1,
		create: ({ close }) => {
			firstClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});
	const second = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: secondController.signal,
		maxPending: 1,
		create: ({ close }) => {
			secondClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});

	expect(h.customCalls()).toBe(1);
	if (firstClose === undefined) throw new Error("Expected first surface to open");
	firstClose("first");
	await expect(first).resolves.toEqual({ status: "closed", value: "first" });
	await Promise.resolve();
	expect(h.customCalls()).toBe(2);
	if (secondClose === undefined) throw new Error("Expected second surface to open");
	secondClose("second");
	await expect(second).resolves.toEqual({ status: "closed", value: "second" });
});

test("removes an aborted queued surface before its factory runs", async () => {
	const h = fixture();
	const firstController = new AbortController();
	const secondController = new AbortController();
	let firstClose: ((value: string) => void) | undefined;
	const first = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: firstController.signal,
		maxPending: 1,
		create: ({ close }) => {
			firstClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});
	let invoked = false;
	const second = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: secondController.signal,
		maxPending: 1,
		create: () => {
			invoked = true;
			return { render: () => [], invalidate: () => undefined };
		},
	});
	secondController.abort();
	await expect(second).rejects.toMatchObject({ name: "AbortError" });
	if (firstClose === undefined) throw new Error("Expected first surface to open");
	firstClose("done");
	await first;
	await Promise.resolve();
	expect(invoked).toBe(false);
});

test("rejects when the caller-declared pending capacity is full", async () => {
	const h = fixture();
	const firstController = new AbortController();
	const secondController = new AbortController();
	const thirdController = new AbortController();
	const first = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: firstController.signal,
		maxPending: 1,
		create: () => ({ render: () => [], invalidate: () => undefined }),
	});
	void openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: secondController.signal,
		maxPending: 1,
		create: () => ({ render: () => [], invalidate: () => undefined }),
	});
	await expect(
		openTuiSurface(h.pi, h.command, {
			hostId: "test",
			signal: thirdController.signal,
			maxPending: 1,
			create: () => ({ render: () => [], invalidate: () => undefined }),
		}),
	).rejects.toBeInstanceOf(TuiSurfaceQueueFullError);
	firstController.abort();
	await expect(first).resolves.toEqual({ status: "aborted" });
});

test("applies pending capacity per stable host ID", async () => {
	const h = fixture();
	let firstClose: ((value: string) => void) | undefined;
	let secondClose: ((value: string) => void) | undefined;
	let thirdClose: ((value: string) => void) | undefined;
	const first = openTuiSurface(h.pi, h.command, {
		hostId: "host-a",
		signal: new AbortController().signal,
		maxPending: 0,
		create: ({ close }) => {
			firstClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});
	const second = openTuiSurface(h.pi, h.command, {
		hostId: "host-b",
		signal: new AbortController().signal,
		maxPending: 1,
		create: ({ close }) => {
			secondClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});
	const third = openTuiSurface(h.pi, h.command, {
		hostId: "host-c",
		signal: new AbortController().signal,
		maxPending: 1,
		create: ({ close }) => {
			thirdClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});

	if (firstClose === undefined) throw new Error("Expected first surface to open");
	firstClose("first");
	await first;
	await Promise.resolve();
	if (secondClose === undefined) throw new Error("Expected second surface to open");
	secondClose("second");
	await second;
	await Promise.resolve();
	if (thirdClose === undefined) throw new Error("Expected third surface to open");
	thirdClose("third");
	await third;
});

test("aborts an active surface and opens the next request", async () => {
	const h = fixture();
	const controller = new AbortController();
	let secondClose: ((value: string) => void) | undefined;
	const first = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: controller.signal,
		maxPending: 1,
		create: () => ({ render: () => [], invalidate: () => undefined }),
	});
	const second = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: new AbortController().signal,
		maxPending: 1,
		create: ({ close }) => {
			secondClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});

	controller.abort();
	await expect(first).resolves.toEqual({ status: "aborted" });
	await Promise.resolve();
	if (secondClose === undefined) throw new Error("Expected second surface to open");
	secondClose("second");
	await second;
});

test("advances the queue when the active factory fails", async () => {
	const h = fixture();
	let secondClose: ((value: string) => void) | undefined;
	const first = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: new AbortController().signal,
		maxPending: 1,
		create: () => {
			throw new Error("factory failed");
		},
	});
	const second = openTuiSurface(h.pi, h.command, {
		hostId: "test",
		signal: new AbortController().signal,
		maxPending: 1,
		create: ({ close }) => {
			secondClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});

	await expect(first).rejects.toThrow("factory failed");
	await Promise.resolve();
	if (secondClose === undefined) throw new Error("Expected second surface to open");
	secondClose("second");
	await second;
});
