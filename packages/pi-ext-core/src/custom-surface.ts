import type {
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";

type SurfaceComponent = Component & { dispose?(): void };

export type TuiSurfaceResult<T> =
	| { readonly status: "closed"; readonly value: T }
	| { readonly status: "aborted" };

/** Context given to a surface only after it owns Pi's custom-UI slot. */
export interface TuiSurfaceContext<T> {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	readonly signal: AbortSignal;
	requestRender(): void;
	close(value: T): void;
}

/**
 * Opens one extension-owned custom surface through the runtime-wide FIFO arbiter.
 *
 * The caller owns visible content, result handling, and non-TUI fallback. It must
 * supply a session-scoped signal and an explicit pending capacity. The factory is
 * called only after this request owns Pi's input slot; abort before that point
 * rejects, while abort after opening resolves with `status: "aborted"`.
 */
export interface OpenTuiSurfaceOptions<T> {
	/** Stable host ID used to apply this host's pending capacity. */
	readonly hostId: string;
	readonly signal: AbortSignal;
	readonly maxPending: number;
	readonly overlay?: boolean;
	readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
	readonly onHandle?: (handle: OverlayHandle) => void;
	create(context: TuiSurfaceContext<T>): SurfaceComponent | Promise<SurfaceComponent>;
}

export class TuiSurfaceQueueFullError extends Error {
	constructor(maxPending: number) {
		super(`TUI surface queue is full (maxPending: ${maxPending})`);
		this.name = "TuiSurfaceQueueFullError";
	}
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	const error = new Error("TUI surface request aborted");
	error.name = "AbortError";
	return error;
}

interface SurfaceRequest {
	readonly hostId: string;
	start(): void;
	abort(reason: unknown): void;
}

interface SurfaceState {
	active?: SurfaceRequest;
	readonly pending: SurfaceRequest[];
}

function surfaceState(pi: ExtensionAPI): SurfaceState {
	const states = getGlobalState(
		"tui-surface-states",
		(): WeakMap<object, SurfaceState> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const existing = states.get(identity);
	if (existing !== undefined) return existing;
	const created: SurfaceState = { pending: [] };
	states.set(identity, created);
	return created;
}

function dequeueNext(state: SurfaceState): void {
	if (state.active !== undefined) return;
	const next = state.pending.shift();
	if (next === undefined) return;
	state.active = next;
	next.start();
}

/**
 * Serializes `ctx.ui.custom()` calls for one Pi runtime. Core owns only the
 * focus slot and cleanup: content, policy, and result interpretation remain
 * with the invoking extension. A caller must not retain its component after
 * this Promise settles because Pi disposes custom components when they close.
 */
export function openTuiSurface<T>(
	pi: ExtensionAPI,
	command: ExtensionCommandContext,
	options: OpenTuiSurfaceOptions<T>,
): Promise<TuiSurfaceResult<T>> {
	if (!Number.isInteger(options.maxPending) || options.maxPending < 0)
		throw new Error("TUI surface maxPending must be a non-negative integer");
	if (!options.hostId.trim()) throw new Error("TUI surface hostId must not be empty");
	if (command.mode !== "tui") throw new Error("TUI surface requires TUI mode");
	if (options.signal.aborted) return Promise.reject(abortError(options.signal.reason));

	const state = surfaceState(pi);
	return new Promise<TuiSurfaceResult<T>>((resolve, reject) => {
		let settled = false;
		let opened = false;
		let complete: ((result: TuiSurfaceResult<T>) => void) | undefined;
		const request: SurfaceRequest = {
			hostId: options.hostId,
			start: () => {
				if (settled) return;
				opened = true;
				void command.ui
					.custom<TuiSurfaceResult<T>>(
						(tui, theme, keybindings, done) => {
							const close = (result: TuiSurfaceResult<T>): void => {
								if (settled) return;
								settled = true;
								done(result);
							};
							complete = close;
							if (options.signal.aborted) {
								close({ status: "aborted" });
								return { render: () => [], invalidate: () => undefined };
							}
							return options.create({
								tui,
								theme,
								keybindings,
								signal: options.signal,
								requestRender: () => tui.requestRender(),
								close: (value) => close({ status: "closed", value }),
							});
						},
						{
							...(options.overlay === true ? { overlay: true } : {}),
							...(options.overlayOptions === undefined
								? {}
								: { overlayOptions: options.overlayOptions }),
							...(options.onHandle === undefined ? {} : { onHandle: options.onHandle }),
						},
					)
					.then(resolve, reject)
					.finally(() => {
						options.signal.removeEventListener("abort", onAbort);
						if (state.active === request) delete state.active;
						dequeueNext(state);
					});
			},
			abort: (reason) => {
				if (settled) return;
				if (!opened) {
					settled = true;
					const index = state.pending.indexOf(request);
					if (index >= 0) state.pending.splice(index, 1);
					options.signal.removeEventListener("abort", onAbort);
					reject(abortError(reason));
					return;
				}
				complete?.({ status: "aborted" });
			},
		};
		const onAbort = (): void => request.abort(options.signal.reason);
		options.signal.addEventListener("abort", onAbort, { once: true });

		if (state.active === undefined) {
			state.active = request;
			request.start();
			return;
		}
		const pendingForHost = state.pending.filter((pending) => pending.hostId === options.hostId);
		if (pendingForHost.length >= options.maxPending) {
			options.signal.removeEventListener("abort", onAbort);
			reject(new TuiSurfaceQueueFullError(options.maxPending));
			return;
		}
		state.pending.push(request);
	});
}
