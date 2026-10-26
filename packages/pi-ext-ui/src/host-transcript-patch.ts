import {
	AssistantMessageComponent,
	type ExtensionContext,
	type ExtensionUIContext,
	InteractiveMode,
	ToolExecutionComponent,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	MouseRegion,
	Spacer,
	stripTerminalSequences,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { renderWithoutToolRails, ToolView, toSingleRow } from "./tool-view.js";

const SEAMS = ["getRegisteredToolDefinition", "showExtensionNotify"] as const;
type Seam = (typeof SEAMS)[number];
type NoticeType = "info" | "warning" | "error";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface Host {
	readonly chat: Container;
	readonly ui: ExtensionUIContext;
	readonly requestRender: () => void;
}

// Audited Pi >=1.0.1 compiles these TS-private members to ordinary JS properties.
// All host-private access stays here; VERSION comes from the running host virtual module.
function readHost(value: unknown): Host {
	if (!record(value)) throw new Error("Invalid InteractiveMode instance");
	const chat = value.chatContainer;
	const session: unknown = value.session;
	const tui: unknown = value.ui;
	if (!record(session) || !record(tui) || typeof tui.requestRender !== "function") {
		throw new Error("Pi host session/TUI shape changed");
	}
	const runner: unknown = session.extensionRunner;
	if (
		!(chat instanceof Container) ||
		!record(runner) ||
		typeof runner.getUIContext !== "function"
	) {
		throw new Error("Pi host transcript/runner shape changed");
	}
	const ui: ExtensionUIContext = runner.getUIContext();
	const requestRender = tui.requestRender;
	return { chat, ui, requestRender: () => requestRender.call(tui) };
}

function assistantInfo(component: AssistantMessageComponent): {
	calls: Set<string>;
	eligible: boolean;
	thinking: boolean;
} {
	const message: unknown = Reflect.get(component, "lastMessage");
	if (!record(message) || !Array.isArray(message.content)) {
		throw new Error("Pi assistant message shape changed");
	}
	const calls = new Set<string>();
	let eligible = !["length", "aborted", "error"].includes(String(message.stopReason));
	let thinking = false;
	for (const block of message.content) {
		if (!record(block)) throw new Error("Pi assistant content shape changed");
		if (block.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
		else if (block.type === "thinking" && typeof block.thinking === "string")
			thinking ||= block.thinking.trim() !== "";
		else if (block.type !== "text" || typeof block.text !== "string" || block.text.trim() !== "")
			eligible = false;
	}
	return { calls, eligible, thinking };
}

interface Member {
	readonly component: Component;
	readonly name?: string;
	readonly summary?: string;
}

function toolMember(component: ToolExecutionComponent, calls: Set<string>): Member | undefined {
	const id: unknown = Reflect.get(component, "toolCallId");
	const name: unknown = Reflect.get(component, "toolName");
	const partial: unknown = Reflect.get(component, "isPartial");
	const result: unknown = Reflect.get(component, "result");
	const renderer: unknown = Reflect.get(component, "resultRendererComponent");
	const callRenderer: unknown = Reflect.get(component, "callRendererComponent");
	if (typeof id !== "string" || typeof name !== "string" || typeof partial !== "boolean") {
		throw new Error("Pi tool component shape changed");
	}
	if (!calls.has(id) || !(callRenderer instanceof ToolView)) return undefined;
	if (
		result !== undefined &&
		(!record(result) ||
			!Array.isArray(result.content) ||
			!result.content.every((block: unknown) => record(block) && block.type === "text") ||
			!(renderer instanceof ToolView))
	)
		return undefined;
	const summary =
		renderer instanceof ToolView
			? (renderer.summary ?? callRenderer.summary)
			: callRenderer.summary;
	if (summary === undefined) return undefined;
	return { component, name: toSingleRow(stripTerminalSequences(name)), summary };
}

class NotifyView extends Container {
	readonly #text = new Text("", 1, 0);
	readonly #context: ExtensionContext;
	readonly #message: string;
	readonly #type: NoticeType;

	constructor(message: string, type: NoticeType, context: ExtensionContext) {
		super();
		this.#context = context;
		this.#message = message;
		this.#type = type;
		this.addChild(new Spacer(1));
		this.addChild(this.#text);
	}

	get summary(): string {
		return this.#context.ui.theme.fg(
			this.#type === "info" ? "dim" : this.#type,
			toSingleRow(`notify · ${this.#content}`),
		);
	}

	get #content(): string {
		const prefix = this.#type === "error" ? "Error: " : this.#type === "warning" ? "Warning: " : "";
		return `${prefix}${this.#message}`;
	}

	override render(width: number): string[] {
		this.#text.setText(
			this.#context.ui.theme.fg(this.#type === "info" ? "dim" : this.#type, this.#content),
		);
		return super.render(width);
	}
}

class ToolGroup extends Container {
	readonly #header = new Text("", 0, 0);
	readonly #originals = new Container();
	readonly #context: ExtensionContext;
	#members: Member[] = [];
	#expanded = false;
	#renderedExpanded = false;

	constructor(context: ExtensionContext, redraw: () => void) {
		super();
		this.#context = context;
		const heading = new MouseRegion(this.#header, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.#expanded = this.#context.ui.getToolsExpanded() ? false : !this.#expanded;
			redraw();
			return { handled: true, render: true };
		});
		const body: Component = {
			render: (width) => {
				const rows = this.#renderedExpanded
					? renderWithoutToolRails(this.#originals, Math.max(1, width - 2))
					: this.#members.flatMap((member) =>
							member.summary === undefined ? [] : [member.summary],
						);
				const rail = this.#context.ui.theme.fg("dim", "▎");
				return rows.map((row) => truncateToWidth(`${rail} ${row}`, Math.max(0, width), "…"));
			},
			handleMouse: (event) => {
				if (!this.#renderedExpanded || event.x < 2) return undefined;
				return this.#originals.handleMouse({
					...event,
					x: event.x - 2,
					width: Math.max(1, event.width - 2),
				});
			},
			invalidate() {},
		};
		this.children = [new Spacer(1), heading, body];
	}

	update(members: Member[]): void {
		this.#members = members;
		this.#originals.children = members.map(({ component, name }): Component => {
			if (name === undefined) return component;
			let offset = 0;
			return {
				render(width) {
					const rows = component.render(width);
					// Pi adds one leading separator per tool; the group supplies its own spacing.
					offset = rows[0] === "" ? 1 : 0;
					return rows.slice(offset);
				},
				handleMouse(event) {
					return component.handleMouse?.({
						...event,
						y: event.y + offset,
						height: event.height + offset,
					});
				},
				invalidate() {},
			};
		});
	}

	override invalidate(): void {
		// Original chatContainer.invalidate invalidates original members exactly once.
		this.#header.invalidate();
	}

	override render(width: number): string[] {
		this.#renderedExpanded = this.#expanded || this.#context.ui.getToolsExpanded();
		const theme = this.#context.ui.theme;
		const counts = new Map<string, number>();
		for (const member of this.#members) {
			if (member.name !== undefined) counts.set(member.name, (counts.get(member.name) ?? 0) + 1);
		}
		const heading = [...counts]
			.map(
				([name, count]) =>
					`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", `×${count}`)}`,
			)
			.join(theme.fg("dim", " · "));
		this.#header.setText(
			truncateToWidth(
				`${theme.fg("dim", this.#renderedExpanded ? "▾" : "▸")} ${heading}`,
				Math.max(0, width),
				"…",
			),
		);
		return super.render(width);
	}
}

interface Attachment {
	dispose(): void;
	notify(message: string, type: NoticeType): boolean;
}

function attach(host: Host, context: ExtensionContext): Attachment {
	const chat = host.chat;
	const original = {
		render: chat.render,
		handleMouse: chat.handleMouse,
		invalidate: chat.invalidate,
	};
	const descriptors = Object.getOwnPropertyDescriptors(chat);
	for (const key of ["render", "handleMouse", "invalidate"]) {
		const descriptor = descriptors[key];
		if (descriptor !== undefined && descriptor.writable !== true) {
			throw new Error(`Pi transcript ${key} cannot be replaced`);
		}
	}
	if (!Object.isExtensible(chat)) throw new Error("Pi transcript cannot accept instance methods");
	const projection = new Container();
	let groups = new Map<Component, ToolGroup>();
	let active = true;
	const rebuild = () => {
		const next = new Map<Component, ToolGroup>();
		const children: Component[] = [];
		let calls = new Set<string>();
		let members: Member[] = [];
		const flush = () => {
			const first = members[0]?.component;
			if (first !== undefined && members.filter((member) => member.name !== undefined).length > 1) {
				const group = groups.get(first) ?? new ToolGroup(context, host.requestRender);
				group.update(members);
				next.set(first, group);
				children.push(group);
			} else children.push(...members.map((member) => member.component));
			members = [];
		};
		for (const child of chat.children) {
			if (child instanceof AssistantMessageComponent) {
				const info = assistantInfo(child);
				calls = info.calls;
				if (info.eligible) {
					members.push({
						component: child,
						...(info.thinking ? { summary: context.ui.theme.fg("thinkingText", "thinking…") } : {}),
					});
					continue;
				}
			} else if (child instanceof ToolExecutionComponent) {
				const member = toolMember(child, calls);
				if (member !== undefined) {
					members.push(member);
					continue;
				}
			} else if (child instanceof NotifyView) {
				members.push({ component: child, summary: child.summary });
				continue;
			}
			flush();
			children.push(child);
		}
		flush();
		groups = next;
		projection.children = children;
	};
	const wrappers = {
		render(width: number): string[] {
			if (!active) return original.render.call(chat, width);
			try {
				rebuild();
			} catch (error) {
				active = false;
				groups.clear();
				projection.clear();
				context.ui.notify(
					`Tool grouping disabled: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return original.render.call(chat, width);
			}
			// Real renderer errors propagate; never hide a tool-rendering failure.
			return projection.render(width);
		},
		handleMouse(event: Parameters<Container["handleMouse"]>[0]) {
			return active ? projection.handleMouse(event) : original.handleMouse.call(chat, event);
		},
		invalidate() {
			original.invalidate.call(chat);
			for (const group of groups.values()) group.invalidate();
		},
	};
	Object.assign(chat, wrappers);
	host.requestRender();
	let disposed = false;
	return {
		notify(message, type) {
			if (!active) return false;
			chat.addChild(new NotifyView(message, type, context));
			host.requestRender();
			return true;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			active = false;
			groups.clear();
			projection.clear();
			let conflict = false;
			for (const key of ["render", "handleMouse", "invalidate"] as const) {
				if (chat[key] !== wrappers[key]) {
					conflict = true;
					continue;
				}
				const descriptor = descriptors[key];
				if (descriptor === undefined) Reflect.deleteProperty(chat, key);
				else Object.defineProperty(chat, key, descriptor);
			}
			if (conflict)
				context.ui.notify(
					"Tool grouping patch changed by another extension; restart Pi to fully unload it.",
					"warning",
				);
			host.requestRender();
		},
	};
}

interface Owner {
	readonly context: ExtensionContext;
	readonly hosts: Map<Container, Attachment & { requestRender(): void }>;
	readonly attach: (host: Host) => Attachment;
	readonly failed: WeakSet<Container>;
}

function connect(owner: Owner, host: Host): void {
	if (owner.hosts.has(host.chat) || owner.failed.has(host.chat)) return;
	try {
		owner.hosts.set(host.chat, { ...owner.attach(host), requestRender: host.requestRender });
	} catch (error) {
		owner.failed.add(host.chat);
		owner.context.ui.notify(
			`Tool grouping unavailable: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}

interface PatchState {
	readonly owners: Map<ExtensionUIContext, Owner>;
	readonly hosts: Set<WeakRef<object>>;
	readonly originals: Record<Seam, PropertyDescriptor>;
	readonly wrappers: {
		getRegisteredToolDefinition(this: unknown, name: string): unknown;
		showExtensionNotify(this: unknown, message: string, type?: NoticeType): unknown;
	};
}

function patchState(): PatchState {
	const prototype = InteractiveMode.prototype;
	const key = Symbol.for("@hheei/pi-ext-ui/host-tool-groups/2");
	const existing = Reflect.get(prototype, key) as PatchState | undefined;
	if (existing !== undefined) {
		if (
			!record(existing) ||
			!(existing.owners instanceof Map) ||
			!(existing.hosts instanceof Set) ||
			!record(existing.originals) ||
			!record(existing.wrappers) ||
			SEAMS.some(
				(seam) =>
					!record(existing.originals[seam]) || typeof existing.wrappers[seam] !== "function",
			)
		)
			throw new Error("Invalid tool grouping patch owner");
		return existing;
	}
	const lookup = Object.getOwnPropertyDescriptor(prototype, SEAMS[0]);
	const notify = Object.getOwnPropertyDescriptor(prototype, SEAMS[1]);
	if (
		typeof lookup?.value !== "function" ||
		!lookup.writable ||
		lookup.value.length !== 1 ||
		typeof notify?.value !== "function" ||
		!notify.writable ||
		notify.value.length !== 2
	)
		throw new Error("Pi tool/notification seam changed or is already patched");
	const owners = new Map<ExtensionUIContext, Owner>();
	const hosts = new Set<WeakRef<object>>();
	const seen = new WeakSet<object>();
	const failed = new WeakSet<object>();
	const locate = (instance: unknown): { owner: Owner; host: Host } | undefined => {
		if (owners.size === 0 || (record(instance) && failed.has(instance))) return undefined;
		let host: Host;
		try {
			host = readHost(instance);
		} catch (error) {
			if (record(instance)) failed.add(instance);
			for (const owner of owners.values())
				owner.context.ui.notify(
					`Tool grouping unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			return undefined;
		}
		if (record(instance) && !seen.has(instance)) {
			seen.add(instance);
			hosts.add(new WeakRef(instance));
		}
		const owner = owners.get(host.ui);
		if (owner === undefined) return undefined;
		connect(owner, host);
		return { owner, host };
	};
	const state: PatchState = {
		owners,
		hosts,
		originals: { getRegisteredToolDefinition: lookup, showExtensionNotify: notify },
		wrappers: {
			getRegisteredToolDefinition(this: unknown, name: string): unknown {
				const result: unknown = Reflect.apply(lookup.value, this, [name]);
				locate(this);
				return result;
			},
			showExtensionNotify(this: unknown, message: string, type?: NoticeType): unknown {
				const match = locate(this);
				if (match?.owner.hosts.get(match.host.chat)?.notify(message, type ?? "info")) return;
				return Reflect.apply(notify.value, this, [message, type]);
			},
		},
	};
	Object.defineProperty(prototype, key, { value: state });
	return state;
}

/** Private to pi-ext-ui: two process hooks, scoped by the actual host UI facade. */
export function installHostToolGroups(context: ExtensionContext): {
	dispose(): void;
	requestRender(): void;
} {
	const parts = VERSION.split(".").map(Number);
	const [major = 0, minor = 0, patch = 0] = parts;
	if (
		parts.length !== 3 ||
		!parts.every(Number.isInteger) ||
		!(major > 1 || (major === 1 && (minor > 0 || (minor === 0 && patch >= 1))))
	)
		throw new Error(`Tool grouping requires Pi >=1.0.1; running ${VERSION}`);
	const state = patchState();
	if (state.owners.has(context.ui)) throw new Error("Tool grouping already owns this UI runtime");
	if (state.owners.size === 0) {
		for (const seam of SEAMS) {
			if (
				Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value !==
				state.originals[seam].value
			)
				throw new Error("Pi tool/notification seam was changed by another extension");
		}
		for (const seam of SEAMS)
			Object.defineProperty(InteractiveMode.prototype, seam, {
				...state.originals[seam],
				value: state.wrappers[seam],
			});
	}
	const owner: Owner = {
		context,
		hosts: new Map(),
		failed: new WeakSet(),
		attach: (host) => attach(host, context),
	};
	state.owners.set(context.ui, owner);
	// Reload rebuilds history before session_start; reconnect already discovered instances.
	for (const reference of state.hosts) {
		const instance = reference.deref();
		if (instance === undefined) {
			state.hosts.delete(reference);
			continue;
		}
		try {
			const host = readHost(instance);
			if (host.ui === context.ui) connect(owner, host);
		} catch {
			state.hosts.delete(reference);
		}
	}
	let disposed = false;
	return {
		requestRender() {
			for (const host of owner.hosts.values()) host.requestRender();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			state.owners.delete(context.ui);
			for (const host of owner.hosts.values()) host.dispose();
			owner.hosts.clear();
			if (state.owners.size !== 0) return;
			for (const seam of SEAMS) {
				if (
					Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value ===
					state.wrappers[seam]
				)
					Object.defineProperty(InteractiveMode.prototype, seam, state.originals[seam]);
				else
					context.ui.notify(
						"Tool grouping seam changed by another extension; restart Pi to fully unload it.",
						"warning",
					);
			}
		},
	};
}
