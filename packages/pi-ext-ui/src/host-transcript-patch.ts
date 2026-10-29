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
	Spacer,
	stripTerminalSequences,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { MessageView } from "./message-view.js";
import { type Member, type ToolGroupRun, ToolGroupView, type Usage } from "./tool-group-view.js";
import { type ToolStatusKind, ToolView, toSingleRow } from "./tool-view.js";

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

function readUsage(value: unknown): Usage | undefined {
	if (!record(value)) return undefined;
	const { input, output, cacheRead, cacheWrite } = value;
	if (
		typeof input !== "number" ||
		typeof output !== "number" ||
		typeof cacheRead !== "number" ||
		typeof cacheWrite !== "number"
	)
		return undefined;
	return { input, output, cacheRead, cacheWrite };
}

function assistantInfo(component: AssistantMessageComponent): {
	calls: Set<string>;
	eligible: boolean;
	thinking: string;
	hidden: boolean;
	usage: Usage | undefined;
} {
	const message: unknown = Reflect.get(component, "lastMessage");
	if (!record(message) || !Array.isArray(message.content)) {
		throw new Error("Pi assistant message shape changed");
	}
	const hidden: unknown = Reflect.get(component, "hideThinkingBlock");
	const calls = new Set<string>();
	let eligible = !["length", "aborted", "error"].includes(String(message.stopReason));
	let thinking = "";
	for (const block of message.content) {
		if (!record(block)) throw new Error("Pi assistant content shape changed");
		if (block.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
		else if (block.type === "thinking" && typeof block.thinking === "string")
			thinking += block.thinking;
		else if (block.type !== "text" || typeof block.text !== "string" || block.text.trim() !== "")
			eligible = false;
	}
	return {
		calls,
		eligible,
		thinking,
		hidden: hidden === true,
		usage: readUsage(message.usage),
	};
}

function toolMember(component: ToolExecutionComponent, calls: Set<string>): Member | undefined {
	const id: unknown = Reflect.get(component, "toolCallId");
	const name: unknown = Reflect.get(component, "toolName");
	const partial: unknown = Reflect.get(component, "isPartial");
	const complete: unknown = Reflect.get(component, "argsComplete");
	const result: unknown = Reflect.get(component, "result");
	const renderer: unknown = Reflect.get(component, "resultRendererComponent");
	const callRenderer: unknown = Reflect.get(component, "callRendererComponent");
	if (
		typeof id !== "string" ||
		typeof name !== "string" ||
		typeof partial !== "boolean" ||
		typeof complete !== "boolean"
	) {
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
	const status: ToolStatusKind = !complete
		? "streaming"
		: partial
			? "running"
			: record(result) && result.isError === true
				? "error"
				: "ok";
	const children = renderer instanceof ToolView ? renderer.children : callRenderer.children;
	const childCount = renderer instanceof ToolView ? renderer.childCount : undefined;
	return {
		kind: "tool",
		component,
		title: toSingleRow(stripTerminalSequences(name)),
		summary,
		status,
		...(children === undefined || children.length === 0 ? {} : { children }),
		...(childCount === undefined ? {} : { childCount }),
	};
}

function messageView(component: Component): MessageView | undefined {
	if (component instanceof MessageView) return component;
	if (!(component instanceof Container)) return undefined;
	for (const child of component.children) if (child instanceof MessageView) return child;
	return undefined;
}

/** Shared transcript notices stay in the group. The frame is the contract, not each custom type. */
function noticeMember(component: Component): Member | undefined {
	const view = messageView(component);
	if (view === undefined) return undefined;
	return {
		kind: "notice",
		component,
		title: view.kind,
		summary: view.activitySummary,
		// A notice with no preview and no body has nothing to open; the group draws a pin only when
		// detail exists, so an unconditional function would give it an arrow onto an empty body.
		...(view.hasDetail ? { detail: (width: number) => view.detailRows(width) } : {}),
	};
}

class NotifyView extends Container {
	readonly #text = new Text("", 1, 0);
	readonly #ui: ExtensionUIContext;
	readonly #message: string;
	readonly #type: NoticeType;

	constructor(message: string, type: NoticeType, ui: ExtensionUIContext) {
		super();
		this.#ui = ui;
		this.#message = message;
		this.#type = type;
		this.addChild(new Spacer(1));
		this.addChild(this.#text);
	}

	get summary(): string {
		return this.#ui.theme.fg(
			this.#type === "info" ? "dim" : this.#type,
			toSingleRow(this.#content),
		);
	}

	get member(): Member {
		return {
			kind: "notice",
			component: this,
			title: this.#type,
			summary: this.summary,
			detail: (width) => this.#detail(width),
		};
	}

	#detail(width: number): string[] {
		const inner = Math.max(1, width - 2);
		return this.#content.split("\n").flatMap((line) => {
			const wrapped = wrapTextWithAnsi(line, inner);
			return (wrapped.length > 0 ? wrapped : [""]).map((row) => `  ${row}`);
		});
	}

	get #content(): string {
		const prefix = this.#type === "error" ? "Error: " : this.#type === "warning" ? "Warning: " : "";
		return `${prefix}${this.#message}`;
	}

	override render(width: number): string[] {
		this.#text.setText(
			this.#ui.theme.fg(this.#type === "info" ? "dim" : this.#type, this.#content),
		);
		return super.render(width);
	}
}

interface RunBox {
	current?: ToolGroupRun | undefined;
}

interface Attachment {
	dispose(): void;
	notify(message: string, type: NoticeType): boolean;
}

function attach(host: Host, run: RunBox): Attachment {
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
	let groups = new Map<Component, ToolGroupView>();
	let active = true;
	const rebuild = () => {
		const next = new Map<Component, ToolGroupView>();
		const children: Component[] = [];
		const blocks: { group: ToolGroupView; members: Member[]; ended: boolean }[] = [];
		let calls = new Set<string>();
		let members: Member[] = [];
		/** Closes the pending run. `ended` is false only for the run still open at the transcript tail. */
		const flush = (ended: boolean) => {
			const first = members[0]?.component;
			if (first !== undefined && members.filter((member) => member.kind === "tool").length > 1) {
				const group =
					groups.get(first) ??
					new ToolGroupView(
						host.ui,
						host.requestRender,
						run.current?.endedAt === undefined ? run.current : undefined,
					);
				blocks.push({ group, members, ended });
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
					const thinking = info.thinking;
					members.push({
						kind: "assistant",
						component: child,
						...(thinking === "" ? {} : { thinkingChars: thinking.length }),
						...(thinking === "" || info.hidden ? {} : { thinking }),
						...(info.usage === undefined ? {} : { usage: info.usage }),
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
				members.push(child.member);
				continue;
			} else {
				const continuation = noticeMember(child);
				if (continuation !== undefined) {
					members.push(continuation);
					continue;
				}
			}
			flush(true);
			children.push(child);
		}
		flush(false);
		const frozen = run.current === undefined || run.current.endedAt !== undefined;
		for (const block of blocks) {
			block.group.update(block.members, frozen || block.ended);
		}
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
				host.ui.notify(
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
			chat.addChild(new NotifyView(message, type, host.ui));
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
				host.ui.notify(
					"Tool grouping patch changed by another extension; restart Pi to fully unload it.",
					"warning",
				);
			host.requestRender();
		},
	};
}

interface Owner {
	readonly ui: ExtensionUIContext;
	readonly hosts: Map<Container, Attachment & { requestRender(): void }>;
	readonly attach: (host: Host) => Attachment;
	readonly failed: WeakSet<Container>;
	readonly run: RunBox;
}

function connect(owner: Owner, host: Host): void {
	if (owner.hosts.has(host.chat) || owner.failed.has(host.chat)) return;
	try {
		owner.hosts.set(host.chat, { ...owner.attach(host), requestRender: host.requestRender });
	} catch (error) {
		owner.failed.add(host.chat);
		owner.ui.notify(
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
				owner.ui.notify(
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
	beginRun(): void;
	endRun(): void;
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
	const ui = context.ui;
	if (state.owners.has(ui)) throw new Error("Tool grouping already owns this UI runtime");
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
	const run: RunBox = {};
	const owner: Owner = {
		ui,
		hosts: new Map(),
		failed: new WeakSet(),
		run,
		attach: (host) => attach(host, run),
	};
	state.owners.set(ui, owner);
	// Reload rebuilds history before session_start; reconnect already discovered instances.
	for (const reference of state.hosts) {
		const instance = reference.deref();
		if (instance === undefined) {
			state.hosts.delete(reference);
			continue;
		}
		try {
			const host = readHost(instance);
			if (host.ui === ui) connect(owner, host);
		} catch {
			state.hosts.delete(reference);
		}
	}
	let disposed = false;
	return {
		requestRender() {
			for (const host of owner.hosts.values()) host.requestRender();
		},
		beginRun() {
			run.current = { startedAt: performance.now() };
		},
		endRun() {
			const current = run.current;
			if (current !== undefined && current.endedAt === undefined)
				current.endedAt = performance.now();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			run.current = undefined;
			state.owners.delete(ui);
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
					ui.notify(
						"Tool grouping seam changed by another extension; restart Pi to fully unload it.",
						"warning",
					);
			}
		},
	};
}
