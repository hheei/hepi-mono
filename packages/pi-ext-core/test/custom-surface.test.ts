import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { openTuiSurface, type TuiSurfaceContext, TuiSurfaceQueueFullError } from "../src/index.js";

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

test("runs beforeRelease once after successful host settlement", async () => {
	const h = fixture();
	let close: ((value: string) => void) | undefined;
	let releases = 0;
	const opening = openTuiSurface(h.pi, h.command, {
		hostId: "successful-release",
		signal: new AbortController().signal,
		maxPending: 0,
		beforeRelease: () => {
			releases++;
		},
		create: (context) => {
			close = context.close;
			return { render: () => [], invalidate: () => undefined };
		},
	});

	if (close === undefined) throw new Error("Expected surface to open");
	close("done");
	await expect(opening).resolves.toEqual({ status: "closed", value: "done" });
	expect(releases).toBe(1);
});

test("runs beforeRelease once and preserves a host failure", async () => {
	const h = fixture();
	const hostFailure = new Error("host failed");
	let releases = 0;
	const opening = openTuiSurface(h.pi, h.command, {
		hostId: "failed-host-release",
		signal: new AbortController().signal,
		maxPending: 0,
		beforeRelease: () => {
			releases++;
		},
		create: () => {
			throw hostFailure;
		},
	});

	await expect(opening).rejects.toBe(hostFailure);
	expect(releases).toBe(1);
});

test("runs beforeRelease once and reports its failure after host success", async () => {
	const h = fixture();
	const releaseFailure = new Error("release failed");
	let close: ((value: string) => void) | undefined;
	let releases = 0;
	const opening = openTuiSurface(h.pi, h.command, {
		hostId: "failed-release",
		signal: new AbortController().signal,
		maxPending: 0,
		beforeRelease: () => {
			releases++;
			throw releaseFailure;
		},
		create: (context) => {
			close = context.close;
			return { render: () => [], invalidate: () => undefined };
		},
	});

	if (close === undefined) throw new Error("Expected surface to open");
	close("done");
	await expect(opening).rejects.toBe(releaseFailure);
	expect(releases).toBe(1);
});

test("runs beforeRelease once and aggregates host and release failures", async () => {
	const h = fixture();
	const hostFailure = new Error("host failed");
	const releaseFailure = new Error("release failed");
	let releases = 0;
	const opening = openTuiSurface(h.pi, h.command, {
		hostId: "dual-failure-release",
		signal: new AbortController().signal,
		maxPending: 0,
		beforeRelease: () => {
			releases++;
			throw releaseFailure;
		},
		create: () => {
			throw hostFailure;
		},
	});

	try {
		await opening;
		throw new Error("Expected aggregate failure");
	} catch (error: unknown) {
		if (!(error instanceof AggregateError)) throw error;
		expect(error.message).toBe("TUI surface host and before-release hook both failed");
		expect(error.errors).toEqual([hostFailure, releaseFailure]);
	}
	expect(releases).toBe(1);
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

interface TestCustomOptions {
	readonly overlay?: boolean;
	readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
	readonly onHandle?: (handle: OverlayHandle) => void;
}

function overlayFixture(
	events: string[],
	beforeSetHidden?: (value: boolean) => void,
): {
	readonly pi: ExtensionAPI;
	readonly command: ExtensionCommandContext;
	readonly handle: OverlayHandle;
	capture(context: TuiSurfaceContext<string>): void;
	context(): TuiSurfaceContext<string>;
	reject(error: unknown): void;
} {
	const pi = { events: {} } as unknown as ExtensionAPI;
	let surfaceContext: TuiSurfaceContext<string> | undefined;
	let rejectCustom: ((error: unknown) => void) | undefined;
	let hidden = false;
	const handle: OverlayHandle = {
		hide: () => events.push("remove"),
		setHidden: (value) => {
			beforeSetHidden?.(value);
			hidden = value;
			events.push(value ? "hide" : "show");
		},
		isHidden: () => hidden,
		focus: () => undefined,
		unfocus: () => undefined,
		isFocused: () => !hidden,
	};
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
				options?: TestCustomOptions,
			): Promise<T> {
				return new Promise<T>((resolve, reject) => {
					rejectCustom = reject;
					factory(
						{ requestRender: () => undefined } as never,
						undefined as never,
						undefined as never,
						resolve,
					);
					options?.onHandle?.(handle);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		pi,
		command,
		handle,
		capture: (context) => {
			surfaceContext = context;
		},
		context: () => {
			if (surfaceContext === undefined) throw new Error("Expected surface context");
			return surfaceContext;
		},
		reject: (error) => {
			if (rejectCustom === undefined) throw new Error("Expected active custom surface");
			rejectCustom(error);
		},
	};
}

function openOverlayFixture(
	h: ReturnType<typeof overlayFixture>,
	controller: AbortController,
	onHandle?: (handle: OverlayHandle) => void,
): Promise<unknown> {
	return openTuiSurface(h.pi, h.command, {
		hostId: "overlay-test",
		signal: controller.signal,
		maxPending: 0,
		overlay: true,
		...(onHandle === undefined ? {} : { onHandle }),
		create: (context) => {
			h.capture(context);
			return { render: () => [], invalidate: () => undefined };
		},
	});
}

test("hides the overlay around an operation and preserves focus-safe cancellation", async () => {
	const events: string[] = [];
	const h = overlayFixture(events);
	const controller = new AbortController();
	let callerHandle: OverlayHandle | undefined;
	const opening = openOverlayFixture(h, controller, (handle) => {
		callerHandle = handle;
	});

	const result = await h.context().withHiddenOverlay(async () => {
		events.push("editor");
		return undefined;
	});

	expect(result).toBeUndefined();
	expect(events).toEqual(["hide", "editor", "show"]);
	expect(callerHandle).toBe(h.handle);
	h.context().close("done");
	await opening;
});

test("rejects hidden operations for non-overlays and before overlay mount", async () => {
	const nonOverlay = overlayFixture([]);
	const nonOverlayOpening = openTuiSurface(nonOverlay.pi, nonOverlay.command, {
		hostId: "plain-test",
		signal: new AbortController().signal,
		maxPending: 0,
		create: (context) => {
			nonOverlay.capture(context);
			return { render: () => [], invalidate: () => undefined };
		},
	});
	await expect(nonOverlay.context().withHiddenOverlay(async () => "unused")).rejects.toThrow(
		"require an overlay surface",
	);
	nonOverlay.context().close("done");
	await nonOverlayOpening;

	const beforeMount = overlayFixture([]);
	let attempted: Promise<string> | undefined;
	const beforeMountOpening = openTuiSurface(beforeMount.pi, beforeMount.command, {
		hostId: "before-mount-test",
		signal: new AbortController().signal,
		maxPending: 0,
		overlay: true,
		create: (context) => {
			beforeMount.capture(context);
			attempted = context.withHiddenOverlay(async () => "unused");
			return { render: () => [], invalidate: () => undefined };
		},
	});
	if (attempted === undefined) throw new Error("Expected pre-mount operation");
	await expect(attempted).rejects.toThrow("Overlay handle is not mounted");
	beforeMount.context().close("done");
	await beforeMountOpening;
});

test("rejects overlapping hidden overlay operations", async () => {
	const events: string[] = [];
	const h = overlayFixture(events);
	const opening = openOverlayFixture(h, new AbortController());
	let release: (() => void) | undefined;
	const first = h.context().withHiddenOverlay(
		() =>
			new Promise<string>((resolve) => {
				release = () => resolve("done");
			}),
	);
	await expect(h.context().withHiddenOverlay(async () => "overlap")).rejects.toThrow(
		"already in progress",
	);
	if (release === undefined) throw new Error("Expected pending operation");
	release();
	await expect(first).resolves.toBe("done");
	expect(events).toEqual(["hide", "show"]);
	h.context().close("done");
	await opening;
});

test("does not restore an overlay after its surface is aborted", async () => {
	const events: string[] = [];
	const h = overlayFixture(events);
	const controller = new AbortController();
	const opening = openOverlayFixture(h, controller);
	let openingSettled = false;
	void opening.then(
		() => (openingSettled = true),
		() => (openingSettled = true),
	);
	let secondClose: ((value: string) => void) | undefined;
	const second = openTuiSurface(h.pi, h.command, {
		hostId: "queued-test",
		signal: new AbortController().signal,
		maxPending: 1,
		create: ({ close }) => {
			secondClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});
	let release: (() => void) | undefined;
	const operation = h.context().withHiddenOverlay(
		() =>
			new Promise<string>((resolve) => {
				release = () => resolve("stale");
			}),
	);
	controller.abort();
	await Promise.resolve();
	expect(openingSettled).toBe(false);
	expect(secondClose).toBeUndefined();
	expect(events).toEqual(["hide"]);
	if (release === undefined) throw new Error("Expected pending operation");
	release();
	await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	expect(events).toEqual(["hide"]);
	await expect(opening).resolves.toEqual({ status: "aborted" });
	await Promise.resolve();
	if (secondClose === undefined) throw new Error("Expected queued surface to open after release");
	secondClose("second");
	await second;
});

test("does not restore an overlay after its surface closes", async () => {
	const events: string[] = [];
	const h = overlayFixture(events);
	const opening = openOverlayFixture(h, new AbortController());
	let openingSettled = false;
	void opening.then(
		() => (openingSettled = true),
		() => (openingSettled = true),
	);
	let secondClose: ((value: string) => void) | undefined;
	const second = openTuiSurface(h.pi, h.command, {
		hostId: "queued-test",
		signal: new AbortController().signal,
		maxPending: 1,
		create: ({ close }) => {
			secondClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});
	let release: (() => void) | undefined;
	const operation = h.context().withHiddenOverlay(
		() =>
			new Promise<string>((resolve) => {
				release = () => resolve("stale");
			}),
	);
	h.context().close("done");
	await Promise.resolve();
	expect(openingSettled).toBe(false);
	expect(secondClose).toBeUndefined();
	expect(events).toEqual(["hide"]);
	if (release === undefined) throw new Error("Expected pending operation");
	release();
	await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	expect(events).toEqual(["hide"]);
	await expect(opening).resolves.toEqual({ status: "closed", value: "done" });
	await Promise.resolve();
	if (secondClose === undefined) throw new Error("Expected queued surface to open after release");
	secondClose("second");
	await second;
});

test("keeps the surface lease after host rejection until a hidden operation completes", async () => {
	const events: string[] = [];
	const h = overlayFixture(events);
	const opening = openOverlayFixture(h, new AbortController());
	let openingSettled = false;
	void opening.then(
		() => (openingSettled = true),
		() => (openingSettled = true),
	);
	let secondClose: ((value: string) => void) | undefined;
	const second = openTuiSurface(h.pi, h.command, {
		hostId: "queued-test",
		signal: new AbortController().signal,
		maxPending: 1,
		create: ({ close }) => {
			secondClose = close;
			return { render: () => [], invalidate: () => undefined };
		},
	});
	let release: (() => void) | undefined;
	const operation = h.context().withHiddenOverlay(
		() =>
			new Promise<string>((resolve) => {
				release = () => resolve("stale");
			}),
	);

	h.reject(new Error("host failed"));
	await Promise.resolve();
	expect(openingSettled).toBe(false);
	expect(secondClose).toBeUndefined();
	expect(events).toEqual(["hide"]);
	if (release === undefined) throw new Error("Expected pending operation");
	release();
	await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	await expect(opening).rejects.toThrow("host failed");
	expect(events).toEqual(["hide"]);
	await Promise.resolve();
	if (secondClose === undefined) throw new Error("Expected queued surface to open after release");
	secondClose("second");
	await second;
});

test("does not wedge hidden operation tracking when hiding fails", async () => {
	let fail = true;
	const events: string[] = [];
	const h = overlayFixture(events, (hidden) => {
		if (hidden && fail) {
			fail = false;
			throw new Error("hide failed");
		}
	});
	const opening = openOverlayFixture(h, new AbortController());

	await expect(h.context().withHiddenOverlay(async () => "unused")).rejects.toThrow("hide failed");
	await expect(h.context().withHiddenOverlay(async () => "done")).resolves.toBe("done");
	expect(events).toEqual(["hide", "show"]);
	h.context().close("done");
	await opening;
});
