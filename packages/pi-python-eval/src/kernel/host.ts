import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@hheei/pi-ext-core";
import { EvalToolError } from "../bridge.js";
import type { EvalExecutionFactsStore, EvalFactWrite } from "../facts.js";
import type { EvalRunResult, EvalRuntimeHooks } from "../runtime.js";
import {
	type ChildToHostMessage,
	EvalCellError,
	type EvalKernelState,
	type EvalLanguage,
	type HostToChildMessage,
	MAX_EVAL_FRAME_CHARS,
} from "./protocol.js";

const READY_TIMEOUT_MS = 10_000;
const INTERRUPT_ESCALATION_MS = 5_000;
/** Bound on output that arrived between cells, so a chatty detached task cannot grow without limit. */
const MAX_BACKGROUND_CHARS = 8_192;

/**
 * The cell's own outcome stands: a failed end write does not change what the cell did. It does change
 * what the next runtime can know, so the cell says the record is missing.
 */
function reportUnsaved(write: EvalFactWrite | undefined, hooks: EvalRuntimeHooks): void {
	if (write === undefined || write.saved) return;
	hooks.onDiagnostic?.(`recovery record not saved: ${write.reason}`);
}

/** What the kernel reported for one cell, before the host adds what it knows about the process. */
type EvalCellOutcome = {
	readonly value: unknown;
	readonly state: EvalKernelState | undefined;
};

type KernelSlot = {
	readonly language: EvalLanguage;
	child: ChildProcessWithoutNullStreams;
	generation: string;
	buffer: string;
	ready: Promise<void>;
};

export class EvalKernelHost {
	readonly #cwd: string;
	readonly #pythonBin: string | undefined;
	readonly #slots = new Map<EvalLanguage, KernelSlot>();
	/** The kernel that ran the last completed cell; a different one means the scope was lost. */
	#lastKernel: KernelSlot | undefined;
	readonly #facts: EvalExecutionFactsStore | undefined;
	#reportedRecovery = false;
	/** Output that arrived with no active cell; the next cell reports it rather than dropping it. */
	#background = "";
	#backgroundTruncated = false;
	#execute:
		| {
				language: EvalLanguage;
				cellId: string;
				hooks: EvalRuntimeHooks;
				resolve: (outcome: EvalCellOutcome) => void;
				reject: (error: Error) => void;
				aborted: boolean;
				state: EvalKernelState | undefined;
				escalate?: ReturnType<typeof setTimeout>;
				abortError?: Error;
		  }
		| undefined;
	#disposed = false;
	readonly #interruptMs: number;

	constructor(
		cwd: string,
		options: {
			readonly pythonBin?: string;
			readonly interruptMs?: number;
			readonly facts?: EvalExecutionFactsStore;
		} = {},
	) {
		this.#cwd = cwd;
		this.#pythonBin = options.pythonBin?.trim() || undefined;
		this.#interruptMs = options.interruptMs ?? INTERRUPT_ESCALATION_MS;
		this.#facts = options.facts;
	}

	async runWithHooks(
		code: string,
		hooks: EvalRuntimeHooks,
		signal?: AbortSignal,
		reset = false,
	): Promise<EvalRunResult> {
		if (this.#disposed) throw new Error("Eval runtime is unavailable after session cleanup.");
		signal?.throwIfAborted();
		if (this.#execute !== undefined) throw new Error("Eval is already running in this session.");
		if (reset) this.#dropKernel("python");
		const previous = this.#lastKernel;
		const history = this.#facts?.previous();
		// A branch that cannot be read is not an empty branch: it may hold an unfinished cell, so the
		// cell says so instead of claiming the last run ended cleanly.
		const historyNote =
			history === undefined || history.readable
				? history?.recovery
				: `earlier python_eval history could not be read (${history.reason}); side effects from an earlier cell cannot be ruled out`;
		// Only the kernel that ran the previous cell can still hold its names. A reset is an
		// explicit request, so it reports nothing; any other change of process is a loss.
		const restarted =
			!reset &&
			((previous !== undefined && this.#slots.get("python") !== previous) ||
				(previous === undefined && history?.readable === true && history.generation !== undefined));
		await this.#ensureChild("python");
		// Recorded before the cell runs: a kernel that dies mid-cell is still the one the next
		// cell has to compare against, so the loss is reported once rather than never.
		this.#lastKernel = this.#slots.get("python");
		const slot = this.#lastKernel;
		if (slot === undefined) throw new Error("python eval kernel is not running.");
		// Delivered before the cell runs, because these bytes were written before it.
		this.#flushBackground(hooks);
		const cellId = crypto.randomUUID();
		const started = this.#facts?.start(cellId, slot.generation);
		// A cell whose start never reached the branch would be invisible to the next runtime, so it is
		// not started at all: the alternative is running code with side effects nothing can report.
		if (started !== undefined && !started.saved)
			throw new Error(
				`python_eval did not run: the recovery record could not be saved (${started.reason}). A cell that leaves no start fact cannot be detected as unfinished after a restart.`,
			);
		const recovery = !reset && !this.#reportedRecovery ? historyNote : undefined;
		this.#reportedRecovery = true;
		let run: EvalCellOutcome;
		try {
			run = await new Promise<EvalCellOutcome>((resolve, reject) => {
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
					this.#interrupt("python");
				};
				this.#execute = {
					language: "python",
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
					state: undefined,
				};
				if (signal?.aborted) {
					fail(abortReason(signal));
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					this.#send("python", { type: "execute", cellId, code });
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			});
		} catch (error) {
			const ended = this.#facts?.end({
				cellId,
				generation: slot.generation,
				outcome:
					signal?.aborted === true ? (isTimeout(signal) ? "timed_out" : "cancelled") : "failed",
				names: error instanceof EvalCellError ? error.state?.names : undefined,
				diagnostic: errorMessage(error),
			});
			reportUnsaved(ended, hooks);
			throw error;
		}
		const ended = this.#facts?.end({
			cellId,
			generation: slot.generation,
			outcome: "completed",
			names: run.state?.names,
		});
		reportUnsaved(ended, hooks);
		return { ...run, restarted, ...(recovery === undefined ? {} : { recovered: recovery }) };
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
		const slot: KernelSlot = {
			language,
			child,
			generation: crypto.randomUUID(),
			buffer: "",
			ready,
		};
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
		if (message.type === "background") {
			this.#appendBackground(message.text);
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
			current.state = message.state;
			if (current.aborted) current.reject(current.abortError ?? new Error("Eval was aborted."));
			else if (message.ok) current.resolve({ value: message.value, state: message.state });
			else current.reject(new EvalCellError(message.error, message.state));
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
								message: errorMessage(error),
							},
			});
		}
	}

	#appendBackground(text: string): void {
		if (text === "") return;
		const room = MAX_BACKGROUND_CHARS - this.#background.length;
		if (room <= 0) {
			this.#backgroundTruncated = true;
			return;
		}
		this.#background += text.slice(0, room);
		if (text.length > room) this.#backgroundTruncated = true;
	}

	#flushBackground(hooks: EvalRuntimeHooks): void {
		const text = this.#background;
		const truncated = this.#backgroundTruncated;
		this.#background = "";
		this.#backgroundTruncated = false;
		if (text !== "") hooks.onBackground(text);
		if (truncated) hooks.onBackground("… background output truncated");
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
		this.#slots.get(language)?.child.kill("SIGINT");
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
	_language: EvalLanguage,
	pythonBin?: string,
): { file: string; args: string[] } {
	return { file: pythonBinary(pythonBin), args: ["-u", pythonChild()] };
}

function pythonChild(): string {
	const directory = fileURLToPath(new URL(".", import.meta.url));
	// Built next to the host, and read from source when a test imports the host directly.
	const nextToHost = join(directory, "child.py");
	if (existsSync(nextToHost)) return nextToHost;
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

function isTimeout(signal: AbortSignal): boolean {
	return signal.reason instanceof Error && signal.reason.message.includes("timed out");
}
