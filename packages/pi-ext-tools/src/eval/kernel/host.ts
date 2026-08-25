import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalToolError } from "../bridge.js";
import type { EvalRuntimeHooks } from "../runtime.js";
import {
	type ChildToHostMessage,
	type EvalLanguage,
	type HostToChildMessage,
	MAX_EVAL_FRAME_CHARS,
} from "./protocol.js";

const READY_TIMEOUT_MS = 10_000;
const INTERRUPT_ESCALATION_MS = 5_000;

type KernelSlot = {
	readonly language: EvalLanguage;
	child: ChildProcessWithoutNullStreams;
	buffer: string;
	ready: Promise<void>;
};

export class EvalKernelHost {
	readonly #cwd: string;
	readonly #pythonBin: string | undefined;
	readonly #slots = new Map<EvalLanguage, KernelSlot>();
	#execute:
		| {
				language: EvalLanguage;
				cellId: string;
				hooks: EvalRuntimeHooks;
				resolve: (value: unknown) => void;
				reject: (error: Error) => void;
				aborted: boolean;
				escalate?: ReturnType<typeof setTimeout>;
				abortError?: Error;
		  }
		| undefined;
	#disposed = false;
	readonly #interruptMs: number;

	constructor(
		cwd: string,
		options: { readonly pythonBin?: string; readonly interruptMs?: number } = {},
	) {
		this.#cwd = cwd;
		this.#pythonBin = options.pythonBin?.trim() || undefined;
		this.#interruptMs = options.interruptMs ?? INTERRUPT_ESCALATION_MS;
	}

	async runWithHooks(
		code: string,
		hooks: EvalRuntimeHooks,
		signal?: AbortSignal,
		language: EvalLanguage = "javascript",
		reset = false,
	): Promise<unknown> {
		if (this.#disposed) throw new Error("Eval runtime is unavailable after session cleanup.");
		signal?.throwIfAborted();
		if (this.#execute !== undefined) throw new Error("Eval is already running in this session.");
		if (reset) this.#dropKernel(language);
		await this.#ensureChild(language);
		const cellId = crypto.randomUUID();
		return await new Promise<unknown>((resolve, reject) => {
			const fail = (error: Error): void => {
				signal?.removeEventListener("abort", onAbort);
				if (this.#execute?.cellId === cellId) {
					clearTimeout(this.#execute.escalate);
					this.#execute = undefined;
				}
				reject(error);
			};
			const onAbort = (): void => {
				if (this.#execute?.cellId === cellId) {
					this.#execute.abortError = abortReason(signal);
				}
				this.#interrupt(language);
			};
			this.#execute = {
				language,
				cellId,
				hooks,
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					if (this.#execute?.cellId === cellId) {
						clearTimeout(this.#execute.escalate);
						const { aborted, abortError } = this.#execute;
						this.#execute = undefined;
						if (aborted) {
							reject(abortError ?? new Error("Eval was aborted."));
							return;
						}
					}
					resolve(value);
				},
				reject: fail,
				aborted: false,
			};
			if (signal?.aborted) {
				fail(abortReason(signal));
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				this.#send(language, { type: "execute", cellId, code });
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#kill(new Error("Eval runtime is unavailable after session cleanup."));
	}

	async #ensureChild(language: EvalLanguage): Promise<void> {
		const existing = this.#slots.get(language);
		if (existing !== undefined) {
			await existing.ready;
			return;
		}
		const command = kernelCommand(language, this.#pythonBin);
		const child = spawn(command.file, command.args, {
			cwd: this.#cwd,
			env: kernelEnv(),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let settleReady: () => void = () => undefined;
		let failReady: (error: Error) => void = () => undefined;
		const ready = new Promise<void>((resolve, reject) => {
			settleReady = resolve;
			failReady = reject;
		});
		const slot: KernelSlot = { language, child, buffer: "", ready };
		this.#slots.set(language, slot);
		const timer = setTimeout(() => {
			failReady(new Error(`${language} eval kernel did not become ready.`));
			this.#kill(new Error(`${language} eval kernel did not become ready.`), language);
		}, READY_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) =>
			this.#onData(slot, chunk, () => {
				clearTimeout(timer);
				settleReady();
			}),
		);
		child.stderr.setEncoding("utf8");
		let stderr = "";
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-8_192);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (this.#slots.get(language) === slot) this.#slots.delete(language);
			const error = new Error(
				`${language} eval kernel exited${code === null ? "" : ` with code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
			);
			failReady(error);
			if (this.#execute?.language === language) {
				this.#execute.reject(error);
				this.#execute = undefined;
			}
		});
		await slot.ready;
	}

	#onData(slot: KernelSlot, chunk: string, onReady: () => void): void {
		slot.buffer += chunk;
		if (slot.buffer.length > MAX_EVAL_FRAME_CHARS && !slot.buffer.includes("\n")) {
			this.#kill(new Error("Eval kernel frame exceeded 1 MiB."), slot.language);
			return;
		}
		for (;;) {
			const index = slot.buffer.indexOf("\n");
			if (index < 0) break;
			const line = slot.buffer.slice(0, index);
			slot.buffer = slot.buffer.slice(index + 1);
			if (line.trim() === "") continue;
			if (line.length > MAX_EVAL_FRAME_CHARS) {
				this.#kill(new Error("Eval kernel frame exceeded 1 MiB."), slot.language);
				return;
			}
			const message = JSON.parse(line) as ChildToHostMessage;
			void this.#handle(slot.language, message, onReady);
		}
	}

	async #handle(
		language: EvalLanguage,
		message: ChildToHostMessage,
		onReady: () => void,
	): Promise<void> {
		if (message.type === "ready") {
			onReady();
			return;
		}
		const current = this.#execute;
		if (
			current === undefined ||
			current.language !== language ||
			!("cellId" in message) ||
			message.cellId !== current.cellId
		)
			return;
		if (message.type === "text") {
			current.hooks.onText(message.text);
			return;
		}
		if (message.type === "display") {
			current.hooks.onDisplay(message.value);
			return;
		}
		if (message.type === "done") {
			if (current.aborted) current.reject(current.abortError ?? new Error("Eval was aborted."));
			else if (message.ok) current.resolve(message.value);
			else current.reject(new Error(message.error));
			return;
		}
		if (message.type !== "toolCall") return;
		try {
			const value = await current.hooks.callTool(message.name, message.args);
			this.#send(language, { type: "toolResult", id: message.id, ok: true, value });
		} catch (error) {
			this.#send(language, {
				type: "toolResult",
				id: message.id,
				ok: false,
				error:
					error instanceof EvalToolError
						? { name: error.name, message: error.message, trace: error.trace }
						: {
								name: error instanceof Error ? error.name : "Error",
								message: error instanceof Error ? error.message : String(error),
							},
			});
		}
	}

	#send(language: EvalLanguage, message: HostToChildMessage): void {
		const child = this.#slots.get(language)?.child;
		if (child === undefined) throw new Error(`${language} eval kernel is not running.`);
		let line = JSON.stringify(message);
		if (line.length > MAX_EVAL_FRAME_CHARS && message.type === "toolResult") {
			line = JSON.stringify({
				type: "toolResult",
				id: message.id,
				ok: false,
				error: { name: "Error", message: "Eval kernel frame exceeded 1 MiB." },
			});
		} else if (line.length > MAX_EVAL_FRAME_CHARS) {
			throw new Error("Eval kernel frame exceeded 1 MiB.");
		}
		child.stdin.write(`${line}\n`);
	}

	#dropKernel(language: EvalLanguage): void {
		const slot = this.#slots.get(language);
		if (slot === undefined) return;
		this.#slots.delete(language);
		slot.child.kill("SIGKILL");
	}

	#interrupt(language: EvalLanguage): void {
		const current = this.#execute;
		if (current === undefined || current.language !== language) return;
		current.aborted = true;
		if (language === "python") this.#slots.get(language)?.child.kill("SIGINT");
		else {
			try {
				this.#send(language, { type: "cancel", cellId: current.cellId });
			} catch {
				this.#kill(new Error("Eval was aborted."), language);
				return;
			}
		}
		current.escalate = setTimeout(() => {
			this.#kill(current.abortError ?? new Error("Eval was aborted."), language);
		}, this.#interruptMs);
	}

	#kill(error: Error, language?: EvalLanguage): void {
		if (
			this.#execute !== undefined &&
			(language === undefined || this.#execute.language === language)
		) {
			clearTimeout(this.#execute.escalate);
			this.#execute.reject(error);
			this.#execute = undefined;
		}
		const languages: EvalLanguage[] = language === undefined ? [...this.#slots.keys()] : [language];
		for (const item of languages) {
			const slot = this.#slots.get(item);
			this.#slots.delete(item);
			slot?.child.kill("SIGKILL");
		}
	}
}

function kernelCommand(
	language: EvalLanguage,
	pythonBin?: string,
): { file: string; args: string[] } {
	if (language === "javascript") {
		const child = javascriptChild();
		return { file: javascriptRuntime(child), args: [child] };
	}
	return { file: pythonBinary(pythonBin), args: ["-u", pythonChild()] };
}

function javascriptRuntime(child: string): string {
	if (!child.endsWith(".ts")) return process.execPath;
	const base = process.execPath.split(/[/\\]/).pop();
	if (base === "bun" || base === "bun.exe") return process.execPath;
	return "bun";
}

function javascriptChild(): string {
	const directory = dirname(fileURLToPath(import.meta.url));
	const source = join(directory, "child.ts");
	if (existsSync(source)) return source;
	return join(directory, "child.js");
}

function pythonChild(): string {
	const directory = dirname(fileURLToPath(import.meta.url));
	const nextToHost = join(directory, "child.py");
	if (existsSync(nextToHost)) return nextToHost;
	const fromPackageSrc = join(directory, "../../../src/eval/kernel/child.py");
	if (existsSync(fromPackageSrc)) return fromPackageSrc;
	throw new Error("Python eval kernel script is missing.");
}

function pythonBinary(explicit?: string): string {
	const candidates = explicit === undefined ? ["python3", "python"] : [explicit];
	for (const candidate of candidates) {
		const probe = spawnSync(
			candidate,
			["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"],
			{ stdio: "ignore" },
		);
		if (probe.status === 0) return candidate;
	}
	if (explicit !== undefined)
		throw new Error(`Eval python bin is not a usable Python 3.9+ interpreter: ${explicit}`);
	throw new Error("Python 3.9+ is required for eval language python.");
}

const KERNEL_ENV_ALLOW = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TERM",
	"TERM_PROGRAM",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SSH_AUTH_SOCK",
	"VIRTUAL_ENV",
	"COLORTERM",
	"PYTHONPATH",
	"LD_LIBRARY_PATH",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"SYSTEMROOT",
	"WINDIR",
	"PATHEXT",
	"COMSPEC",
]);

function kernelEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: "1" };
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		const upper = key.toUpperCase();
		if (
			upper.includes("API_KEY") ||
			upper.endsWith("_TOKEN") ||
			upper.endsWith("_SECRET") ||
			upper.endsWith("_PASSWORD")
		)
			continue;
		if (
			KERNEL_ENV_ALLOW.has(upper) ||
			upper.startsWith("LC_") ||
			upper.startsWith("XDG_") ||
			upper.startsWith("PI_")
		)
			env[key] = value;
	}
	return env;
}

function abortReason(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error && reason.message.includes("timed out")) return reason;
	return new Error("Eval was aborted.");
}
