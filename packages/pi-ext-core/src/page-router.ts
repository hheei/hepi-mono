import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { openTuiSurface } from "./custom-surface.js";
import { getGlobalState } from "./global-state.js";
import type { ExtensionLifecycleContext } from "./lifecycle.js";
import { runtimeIdentity } from "./runtime-identity.js";

/** Context created for one lazily constructed page view. The signal ends with the router. */
export interface ExtensionPageViewContext {
	readonly command: ExtensionCommandContext;
	readonly signal: AbortSignal;
	readonly theme: Theme;
	/** Requests host rendering after the contributor changes its own state. */
	requestRender(): void;
	/** Opens Pi's native editor while temporarily hiding the router overlay. */
	openEditor(title: string, prefill?: string): Promise<string | undefined>;
	/** Closes the Settings surface after the page finishes its own async cleanup or save. */
	requestClose(): void;
}

/**
 * A contributor-owned component and its cleanup for one open router surface.
 * `handleInput` gets first refusal; returning true prevents router tab/close keys.
 */
export interface ExtensionPageView {
	readonly component: Component;
	/** Minimum content rows retained by the router below its shared tab strip. */
	readonly minRows?: number;
	handleInput(input: string): boolean | Promise<boolean>;
	onThemeChange?(theme: Theme): void;
	close(): void | Promise<void>;
}

/** One lifecycle-bound tab in the global Extension page router. */
export interface ExtensionPageRegistration {
	readonly id: string;
	readonly label: string;
	readonly order: number;
	/** Lazily creates a view only when this page becomes selected. */
	create(context: ExtensionPageViewContext): Promise<ExtensionPageView>;
}

export interface OpenExtensionPageRouterOptions {
	/** Stable custom-surface host identity used for this command's pending bound. */
	readonly hostId: string;
	readonly signal: AbortSignal;
	/** Explicit FIFO capacity; core does not choose an implicit global limit. */
	readonly maxPending: number;
	readonly initialPageId?: string;
	readonly overlay?: boolean;
	readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
	/**
	 * Acquires host-owned resources only after this router owns Pi's custom surface slot.
	 * The returned cleanup is awaited after attached, detached, and late-created views close.
	 */
	onSurfaceOpen?(): undefined | (() => void | Promise<void>);
}

interface RouterState {
	readonly pages: Map<string, ExtensionPageRegistration>;
	active?: WeakRef<RouterController>;
}

interface RouterController {
	onPagesChanged(): void;
}

function stateFor(pi: ExtensionAPI): RouterState {
	const states = getGlobalState(
		"extension-page-router-states",
		(): WeakMap<object, RouterState> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const current = states.get(identity);
	if (current !== undefined) return current;
	const created: RouterState = { pages: new Map() };
	states.set(identity, created);
	return created;
}

function sortedPages(state: RouterState): readonly ExtensionPageRegistration[] {
	return [...state.pages.values()].sort(
		(left, right) => left.order - right.order || left.id.localeCompare(right.id),
	);
}

/** Registers a page for this lifecycle; the router removes it during cleanup. */
export function registerExtensionPage(
	context: ExtensionLifecycleContext,
	registration: ExtensionPageRegistration,
): void {
	if (!registration.id.trim()) throw new Error("Extension page id must not be empty");
	if (!registration.label.trim()) throw new Error("Extension page label must not be empty");
	if (!Number.isFinite(registration.order) || registration.order < 0)
		throw new Error("Extension page order must be a non-negative finite number");
	const state = stateFor(context.pi);
	if (state.pages.has(registration.id))
		throw new Error(`Extension page id collision: ${registration.id}`);
	state.pages.set(registration.id, registration);
	state.active?.deref()?.onPagesChanged();
	context.resources.add(`extension-page:${registration.id}`, () => {
		if (state.pages.get(registration.id) !== registration) return;
		state.pages.delete(registration.id);
		state.active?.deref()?.onPagesChanged();
	});
}

/**
 * Opens the global page router from the single Settings host command. Core owns
 * tab navigation and view lifecycle; page contributors own content, business state,
 * and input semantics that they consume before router navigation.
 */
export async function openExtensionPageRouter(
	pi: ExtensionAPI,
	command: ExtensionCommandContext,
	options: OpenExtensionPageRouterOptions,
): Promise<void> {
	const state = stateFor(pi);
	if (state.pages.size === 0) return;
	let finalizeSurface: (() => Promise<void>) | undefined;
	await openTuiSurface(pi, command, {
		hostId: options.hostId,
		signal: options.signal,
		maxPending: options.maxPending,
		...(options.overlay === true ? { overlay: true } : {}),
		...(options.overlayOptions === undefined ? {} : { overlayOptions: options.overlayOptions }),
		beforeRelease: () => finalizeSurface?.(),
		create: ({ theme, requestRender, withHiddenOverlay, close }) => {
			const releaseSurfaceResources = options.onSurfaceOpen?.();
			const controller = new AbortController();
			let currentTheme = theme;
			let selectedId =
				options.initialPageId !== undefined && state.pages.has(options.initialPageId)
					? options.initialPageId
					: sortedPages(state)[0]?.id;
			const views = new Map<string, ExtensionPageView>();
			const failures = new Map<string, string>();
			const creationTasks = new Set<Promise<void>>();
			const detachedCleanupTasks = new Set<Promise<void>>();
			let closed = false;
			let finalization: Promise<void> | undefined;
			let input = Promise.resolve();

			const closeViews = async (): Promise<void> => {
				// A page creation already in flight when the surface closes owns its
				// late view cleanup. Await those tasks before closing attached views,
				// then aggregate every sync and async cleanup failure.
				const backgroundResults = await Promise.allSettled([
					...creationTasks,
					...detachedCleanupTasks,
				]);
				const viewResults = await Promise.allSettled(
					[...views.values()].map((view) => Promise.resolve().then(() => view.close())),
				);
				const results = [...backgroundResults, ...viewResults];
				const errors = results.flatMap((result) =>
					result.status === "rejected" ? [result.reason] : [],
				);
				if (errors.length > 0)
					throw new AggregateError(errors, "Extension page view cleanup failed");
			};
			const pageList = (): readonly ExtensionPageRegistration[] => sortedPages(state);
			const closeRemovedViews = (): void => {
				for (const [id, view] of views) {
					if (state.pages.has(id)) continue;
					views.delete(id);
					const cleanup = Promise.resolve().then(() => view.close());
					detachedCleanupTasks.add(cleanup);
					// Finalization awaits the original Promise and aggregates its error;
					// this handler only prevents an early unhandled rejection.
					void cleanup.catch(() => requestRender());
				}
			};
			const selectFallback = (): void => {
				const pages = pageList();
				if (selectedId !== undefined && state.pages.has(selectedId)) return;
				selectedId = pages[0]?.id;
			};
			const createSelected = async (): Promise<void> => {
				// A page may be removed or selection may change while create() awaits;
				// close that late view instead of attaching it to a stale router state.
				selectFallback();
				const id = selectedId;
				if (id === undefined || views.has(id) || failures.has(id) || closed) return;
				const registration = state.pages.get(id);
				if (registration === undefined) return;
				try {
					let view: ExtensionPageView;
					try {
						view = await registration.create({
							command,
							signal: controller.signal,
							theme: currentTheme,
							requestRender,
							openEditor: (title, prefill) =>
								withHiddenOverlay(() => command.ui.editor(title, prefill)),
							requestClose: () => close(undefined),
						});
					} catch (error: unknown) {
						// A creator may reject intentionally when its signal is aborted;
						// only report failures while this page is still current.
						if (!closed && selectedId === id)
							failures.set(id, error instanceof Error ? error.message : "Unable to open page");
						return;
					}
					if (
						closed ||
						controller.signal.aborted ||
						selectedId !== id ||
						state.pages.get(id) !== registration
					) {
						await view.close();
						return;
					}
					if (view.minRows !== undefined && (!Number.isInteger(view.minRows) || view.minRows < 0)) {
						await view.close();
						failures.set(id, `Extension page ${id} minRows must be a non-negative integer`);
						return;
					}
					views.set(id, view);
				} finally {
					requestRender();
				}
			};
			const startCreateSelected = (): void => {
				const task = createSelected();
				creationTasks.add(task);
				// Keep the original Promise in the set through finalization so a
				// rejection that precedes surface close is still observed there.
				void task.catch(() => undefined);
			};
			const select = (offset: number): void => {
				const pages = pageList();
				if (pages.length === 0) {
					close(undefined);
					return;
				}
				const currentIndex = Math.max(
					0,
					pages.findIndex((page) => page.id === selectedId),
				);
				selectedId = pages[(currentIndex + offset + pages.length) % pages.length]?.id;
				failures.delete(selectedId ?? "");
				startCreateSelected();
				requestRender();
			};
			const router: RouterController = {
				onPagesChanged: (): void => {
					closeRemovedViews();
					selectFallback();
					if (selectedId === undefined) close(undefined);
					else startCreateSelected();
					requestRender();
				},
			};
			const finalize = (): Promise<void> => {
				if (finalization !== undefined) return finalization;
				closed = true;
				controller.abort();
				if (state.active?.deref() === router) delete state.active;
				// Defer closeViews until after `finalization` is assigned so a
				// synchronous contributor close cannot re-enter this finalizer.
				finalization = Promise.resolve()
					.then(closeViews)
					.finally(async () => {
						await releaseSurfaceResources?.();
					});
				return finalization;
			};
			finalizeSurface = finalize;
			state.active = new WeakRef(router);
			startCreateSelected();

			return {
				render(width: number): string[] {
					selectFallback();
					const pages = pageList();
					const tabs = pages
						.map((page) => {
							const label =
								page.id === selectedId
									? currentTheme.fg("accent", page.label)
									: currentTheme.fg("muted", page.label);
							return page.id === selectedId ? currentTheme.bold(label) : label;
						})
						.join(currentTheme.fg("dim", "  "));
					const border = currentTheme.fg("border", "─".repeat(Math.max(0, width)));
					const lines = [border, truncateToWidth(tabs, width), border];
					const id = selectedId;
					const view = id === undefined ? undefined : views.get(id);
					if (view !== undefined) {
						const content = view.component.render(width);
						const padding = Math.max(0, (view.minRows ?? 0) - content.length);
						return [...lines, ...content, ...Array.from({ length: padding }, () => ""), border];
					}
					const failure = id === undefined ? undefined : failures.get(id);
					return [
						...lines,
						currentTheme.fg(
							failure === undefined ? "muted" : "error",
							failure ?? "Opening page...",
						),
						border,
					];
				},
				handleInput(data: string): void {
					input = input
						.then(async () => {
							const id = selectedId;
							const view = id === undefined ? undefined : views.get(id);
							// Contributor input has first refusal by contract. Router keys are
							// considered only when the selected page declines the event.
							if (view !== undefined && (await view.handleInput(data))) return;
							if (matchesKey(data, Key.escape)) {
								close(undefined);
								return;
							}
							if (matchesKey(data, Key.left)) select(-1);
							else if (matchesKey(data, Key.right)) select(1);
						})
						.catch(() => requestRender());
				},
				invalidate(): void {
					currentTheme = command.ui.theme;
					for (const view of views.values()) view.onThemeChange?.(currentTheme);
					requestRender();
				},
				dispose(): void {
					void finalize().catch(() => requestRender());
				},
			};
		},
	});
}
