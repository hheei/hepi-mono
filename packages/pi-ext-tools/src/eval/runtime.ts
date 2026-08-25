import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import { parse } from "acorn";

export interface EvalRuntimeHooks {
	readonly cwd: string;
	onText(text: string): void;
	onDisplay(value: unknown): void;
	callTool(name: string, args: unknown): Promise<unknown>;
}

type RunContext = { readonly hooks: EvalRuntimeHooks; active: boolean };
type AstNode = {
	readonly type: string;
	readonly name?: string;
	readonly kind?: string;
	readonly start?: number;
	readonly end?: number;
	readonly body?: readonly AstNode[];
	readonly declarations?: readonly AstNode[];
	readonly id?: AstNode | null;
	readonly argument?: AstNode | null;
	readonly properties?: readonly AstNode[];
	readonly elements?: readonly (AstNode | null)[];
	readonly value?: AstNode;
	readonly left?: AstNode;
	readonly callee?: AstNode;
};

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (scope: object) => Promise<unknown>;

const RESERVED = new Set([
	"scope",
	"tool",
	"print",
	"display",
	"cwd",
	"console",
	"setTimeout",
	"setInterval",
	"clearTimeout",
	"clearInterval",
	"__eval_set_final__",
]);

/**
 * One trusted inline JavaScript scope. It does not mutate host globals or provide a sandbox.
 * Detached work has no active hook context once a run completes.
 */
export class JsRuntime {
	readonly #hooks = new AsyncLocalStorage<RunContext>();
	readonly #scope: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	readonly #bindings = new Set<string>();
	readonly #timers = new Set<unknown>();
	#disposed = false;

	constructor(_cwd: string) {
		this.#installHelpers();
	}

	async runWithHooks(
		code: string,
		hooks: EvalRuntimeHooks,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.#disposed) throw new Error("Eval runtime is unavailable after session cleanup.");
		signal?.throwIfAborted();
		const rewritten = rewriteSource(code);
		const source = compileSource(rewritten.source, [...this.#bindings, ...rewritten.bindings]);
		const context: RunContext = { hooks, active: true };
		let finalSet = false;
		let finalValue: unknown;
		this.#scope.__eval_set_final__ = (value: unknown) => {
			finalSet = true;
			finalValue = value;
			return value;
		};
		try {
			const run = this.#hooks.run(context, async () => {
				await new AsyncFunction("scope", source)(this.#scope);
			});
			await (signal === undefined ? run : Promise.race([run, aborted(signal)]));
			return finalSet ? finalValue : undefined;
		} finally {
			for (const name of rewritten.bindings) this.#bindings.add(name);
			delete this.#scope.__eval_set_final__;
			context.active = false;
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.clearTimers();
		this.#bindings.clear();
		for (const key of Object.keys(this.#scope)) delete this.#scope[key];
	}

	clearTimers(): void {
		for (const id of this.#timers) {
			globalThis.clearTimeout(id as never);
			globalThis.clearInterval(id as never);
		}
		this.#timers.clear();
	}

	#requireHooks(): EvalRuntimeHooks {
		const context = this.#hooks.getStore();
		if (context === undefined || !context.active)
			throw new Error("Eval helper called outside an active run.");
		return context.hooks;
	}

	#installHelpers(): void {
		const originalConsole = globalThis.console;
		const log = (level: "log" | "info" | "warn" | "error" | "debug", args: unknown[]): void => {
			const context = this.#hooks.getStore();
			if (context === undefined || !context.active) {
				originalConsole[level](...args);
				return;
			}
			const prefix = level === "warn" ? "[warn] " : level === "error" ? "[error] " : "";
			context.hooks.onText(`${prefix}${args.map(formatValue).join(" ")}\n`);
		};
		const consoleBridge = Object.create(originalConsole) as Console;
		for (const level of ["log", "info", "warn", "error", "debug"] as const)
			Object.defineProperty(consoleBridge, level, {
				value: (...args: unknown[]) => log(level, args),
			});
		Object.assign(this.#scope, {
			tool: new Proxy(
				{},
				{
					get: (_target, property) => {
						if (typeof property !== "string") return undefined;
						return async (args: unknown = {}) =>
							await this.#requireHooks().callTool(property, args);
					},
				},
			),
			print: (...values: unknown[]) =>
				this.#requireHooks().onText(`${values.map(formatValue).join(" ")}\n`),
			display: (value: unknown) => this.#requireHooks().onDisplay(value),
			cwd: () => this.#requireHooks().cwd,
			console: consoleBridge,
			setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
				const id = globalThis.setTimeout(() => {
					this.#timers.delete(id);
					try {
						callback(...args);
					} catch {
						return;
					}
				}, delay);
				this.#timers.add(id);
				return id;
			},
			setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
				const id = globalThis.setInterval(() => {
					try {
						callback(...args);
					} catch {
						return;
					}
				}, delay);
				this.#timers.add(id);
				return id;
			},
			clearTimeout: (id: unknown) => {
				this.#timers.delete(id);
				globalThis.clearTimeout(id as never);
			},
			clearInterval: (id: unknown) => {
				this.#timers.delete(id);
				globalThis.clearInterval(id as never);
			},
		});
	}
}

function rewriteSource(code: string): {
	readonly source: string;
	readonly bindings: readonly string[];
} {
	const program = parse(code, {
		ecmaVersion: "latest",
		sourceType: "script",
		allowAwaitOutsideFunction: true,
		allowReturnOutsideFunction: true,
	}) as AstNode;
	if (containsUnsupportedModuleLoading(program))
		throw new Error("Eval does not support module loading or require().");
	const statements = [...(program.body ?? [])];
	while (statements.at(-1)?.type === "EmptyStatement") statements.pop();
	const bindings = topLevelBindings(statements);
	const replacements: Array<{
		readonly start: number;
		readonly end: number;
		readonly text: string;
	}> = [];
	for (const statement of statements) {
		const start = statement.start;
		const end = statement.end;
		if (start === undefined || end === undefined) continue;
		if (
			statement.type === "VariableDeclaration" &&
			(statement.kind === "let" || statement.kind === "const")
		) {
			replacements.push({
				start,
				end,
				text: `var${code.slice(start + statement.kind.length, end)}${publishSuffix(statement)}`,
			});
		} else if (statement.type === "ClassDeclaration" && statement.id?.name !== undefined) {
			const idEnd = statement.id.end;
			if (idEnd === undefined) continue;
			replacements.push({
				start,
				end,
				text: `var ${statement.id.name} = class${code.slice(idEnd, end)}${publishSuffix(statement)}`,
			});
		} else if (
			statement.type === "FunctionDeclaration" ||
			(statement.type === "VariableDeclaration" && statement.kind === "var")
		) {
			replacements.push({
				start: end,
				end,
				text: publishSuffix(statement),
			});
		}
	}
	const last = statements.at(-1);
	if (last?.start !== undefined && last.end !== undefined) {
		if (last.type === "ExpressionStatement") {
			const raw = code.slice(last.start, last.end).replace(/;\s*$/u, "");
			replacements.push({
				start: last.start,
				end: last.end,
				text: `__eval_set_final__((${raw}));`,
			});
		} else if (last.type === "ReturnStatement") {
			const argument =
				last.argument?.start === undefined || last.argument.end === undefined
					? "undefined"
					: code.slice(last.argument.start, last.argument.end);
			replacements.push({
				start: last.start,
				end: last.end,
				text: `__eval_set_final__((${argument}));`,
			});
		}
	}
	replacements.sort((left, right) => right.start - left.start || right.end - left.end);
	let source = code;
	for (const replacement of replacements)
		source = `${source.slice(0, replacement.start)}${replacement.text}${source.slice(replacement.end)}`;
	return { source, bindings };
}

function compileSource(userSource: string, bindings: readonly string[]): string {
	const names = [...new Set(bindings)].filter((name) => !RESERVED.has(name));
	const inject = [
		"var tool = scope.tool;",
		"var print = scope.print;",
		"var display = scope.display;",
		"var cwd = scope.cwd;",
		"var console = scope.console;",
		"var setTimeout = scope.setTimeout;",
		"var setInterval = scope.setInterval;",
		"var clearTimeout = scope.clearTimeout;",
		"var clearInterval = scope.clearInterval;",
		"var __eval_set_final__ = scope.__eval_set_final__;",
		...names.map((name) => `var ${name} = scope[${JSON.stringify(name)}];`),
	].join("\n");
	return `return await (async () => {\n${inject}\n${userSource}\n})();\n//# sourceURL=pi-ext-tools-eval.js`;
}

function publishSuffix(statement: AstNode): string {
	const names: string[] = [];
	if (statement.type === "VariableDeclaration") {
		for (const declaration of statement.declarations ?? [])
			collectBindingNames(declaration.id, names);
	} else collectBindingNames(statement.id, names);
	return names
		.filter((name) => !RESERVED.has(name))
		.map((name) => `;scope[${JSON.stringify(name)}] = ${name};`)
		.join("");
}

function topLevelBindings(statements: readonly AstNode[]): readonly string[] {
	const bindings = new Set<string>();
	for (const statement of statements) {
		if (statement.type === "VariableDeclaration") {
			for (const declaration of statement.declarations ?? [])
				collectBindingNames(declaration.id, bindings);
		} else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
			collectBindingNames(statement.id, bindings);
		}
	}
	return [...bindings].filter((name) => !RESERVED.has(name));
}

function collectBindingNames(
	node: AstNode | null | undefined,
	bindings: Set<string> | string[],
): void {
	if (node === undefined || node === null) return;
	if (node.type === "Identifier" && typeof node.name === "string") {
		if (Array.isArray(bindings)) bindings.push(node.name);
		else bindings.add(node.name);
		return;
	}
	if (node.type === "RestElement") collectBindingNames(node.argument, bindings);
	if (node.type === "AssignmentPattern") collectBindingNames(node.left, bindings);
	if (node.type === "ArrayPattern")
		for (const element of node.elements ?? []) collectBindingNames(element, bindings);
	if (node.type === "ObjectPattern")
		for (const property of node.properties ?? []) collectBindingNames(property, bindings);
	if (node.type === "Property") collectBindingNames(node.value, bindings);
}

function containsUnsupportedModuleLoading(node: unknown): boolean {
	if (typeof node !== "object" || node === null) return false;
	if (Array.isArray(node)) return node.some(containsUnsupportedModuleLoading);
	const record = node as Record<string, unknown>;
	if (record.type === "ImportExpression") return true;
	if (
		record.type === "CallExpression" &&
		typeof record.callee === "object" &&
		record.callee !== null &&
		(record.callee as { readonly type?: unknown; readonly name?: unknown }).type === "Identifier" &&
		(record.callee as { readonly name?: unknown }).name === "require"
	)
		return true;
	return Object.values(record).some(containsUnsupportedModuleLoading);
}

function aborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const fail = (): void => {
			const reason = signal.reason;
			reject(
				reason instanceof Error && reason.message.includes("timed out")
					? reason
					: new Error("Eval was aborted."),
			);
		};
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	});
}

function formatValue(value: unknown): string {
	return typeof value === "string"
		? value
		: inspect(value, { depth: 4, colors: false, breakLength: 100 });
}
