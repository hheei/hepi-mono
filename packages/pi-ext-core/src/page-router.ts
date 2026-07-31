import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { openTuiSurface } from "./custom-surface.js";
import { getGlobalState } from "./global-state.js";
import type { ExtensionLifecycleContext } from "./lifecycle.js";
import { runtimeIdentity } from "./runtime-identity.js";

/*
 * TODO(pi-settings migration): Move /ext-settings ownership from
 * packages/hepi-basics/src/core/command/hepi-command.ts and migrate the
 * Settings page in core/ui/settings/, its core/ui helpers, and its focused
 * tests into packages/pi-settings. See docs/architecture/tui.md; do not make
 * pi-settings depend on the transitional hepi-basics aggregate.
 */

/** Context created for one lazily constructed page view. */
export interface ExtensionPageViewContext {
	readonly command: ExtensionCommandContext;
	readonly signal: AbortSignal;
	readonly theme: Theme;
	requestRender(): void;
}

/** A contributor-owned component and its cleanup for one open router surface. */
export interface ExtensionPageView {
	readonly component: Component;
	handleInput(input: string): boolean | Promise<boolean>;
	onThemeChange?(theme: Theme): void;
	close(): void | Promise<void>;
}

/** One lifecycle-bound tab in the global Extension page router. */
export interface ExtensionPageRegistration {
	readonly id: string;
	readonly label: string;
	readonly order: number;
	create(context: ExtensionPageViewContext): Promise<ExtensionPageView>;
}

export interface OpenExtensionPageRouterOptions {
	readonly hostId: string;
	readonly signal: AbortSignal;
	readonly maxPending: number;
	readonly initialPageId?: string;
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

/** Opens the global page router from the single Settings host command. */
export async function openExtensionPageRouter(
	pi: ExtensionAPI,
	command: ExtensionCommandContext,
	options: OpenExtensionPageRouterOptions,
): Promise<void> {
	const state = stateFor(pi);
	if (state.pages.size === 0) return;
	await openTuiSurface(pi, command, {
		hostId: options.hostId,
		signal: options.signal,
		maxPending: options.maxPending,
		create: ({ theme, requestRender, close }) => {
			const controller = new AbortController();
			let currentTheme = theme;
			let selectedId =
				options.initialPageId !== undefined && state.pages.has(options.initialPageId)
					? options.initialPageId
					: sortedPages(state)[0]?.id;
			const views = new Map<string, ExtensionPageView>();
			const failures = new Map<string, string>();
			let closed = false;
			let input = Promise.resolve();

			const closeViews = async (): Promise<void> => {
				const results = await Promise.allSettled([...views.values()].map((view) => view.close()));
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
					void Promise.resolve(view.close()).catch(() => requestRender());
				}
			};
			const selectFallback = (): void => {
				const pages = pageList();
				if (selectedId !== undefined && state.pages.has(selectedId)) return;
				selectedId = pages[0]?.id;
			};
			const createSelected = async (): Promise<void> => {
				selectFallback();
				const id = selectedId;
				if (id === undefined || views.has(id) || failures.has(id) || closed) return;
				const registration = state.pages.get(id);
				if (registration === undefined) return;
				try {
					const view = await registration.create({
						command,
						signal: controller.signal,
						theme: currentTheme,
						requestRender,
					});
					if (
						closed ||
						controller.signal.aborted ||
						selectedId !== id ||
						state.pages.get(id) !== registration
					) {
						await view.close();
						return;
					}
					views.set(id, view);
				} catch (error: unknown) {
					if (!closed && selectedId === id)
						failures.set(id, error instanceof Error ? error.message : "Unable to open page");
				} finally {
					requestRender();
				}
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
				void createSelected();
				requestRender();
			};
			const router: RouterController = {
				onPagesChanged: (): void => {
					closeRemovedViews();
					selectFallback();
					if (selectedId === undefined) close(undefined);
					else void createSelected();
					requestRender();
				},
			};
			state.active = new WeakRef(router);
			void createSelected();

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
					const lines = [truncateToWidth(`${tabs}  ${currentTheme.fg("dim", "↔")}`, width)];
					const id = selectedId;
					const view = id === undefined ? undefined : views.get(id);
					if (view !== undefined) return [...lines, ...view.component.render(width)];
					const failure = id === undefined ? undefined : failures.get(id);
					return [
						...lines,
						currentTheme.fg(
							failure === undefined ? "muted" : "error",
							failure ?? "Opening page...",
						),
					];
				},
				handleInput(data: string): void {
					input = input
						.then(async () => {
							const id = selectedId;
							const view = id === undefined ? undefined : views.get(id);
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
					if (closed) return;
					closed = true;
					controller.abort();
					if (state.active?.deref() === router) delete state.active;
					void closeViews();
				},
			};
		},
	});
}
