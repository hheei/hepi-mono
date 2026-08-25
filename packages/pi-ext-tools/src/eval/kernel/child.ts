import { EvalToolError } from "../bridge.js";
import { JsRuntime } from "../runtime.js";
import {
	type ChildToHostMessage,
	type HostToChildMessage,
	MAX_EVAL_FRAME_CHARS,
} from "./protocol.js";

const SESSION_CWD = process.cwd();
const runtime = new JsRuntime(SESSION_CWD);
let active: { readonly cellId: string; readonly abort: AbortController } | undefined;
const pendingTools = new Map<
	string,
	(message: Extract<HostToChildMessage, { type: "toolResult" }>) => void
>();
const frameWrite = process.stdout.write.bind(process.stdout);

for (const stream of [process.stdout, process.stderr]) {
	const original = stream.write.bind(stream);
	stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
		if (active !== undefined) {
			send({
				type: "text",
				cellId: active.cellId,
				text: stdioChunk(chunk, typeof encoding === "string" ? encoding : undefined),
			});
			const done = typeof encoding === "function" ? encoding : callback;
			if (typeof done === "function") (done as (error?: Error | null) => void)();
			return true;
		}
		return original(chunk as never, encoding as never, callback as never);
	}) as typeof stream.write;
}

startParentWatchdog();

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string | Buffer) => {
	buffer += String(chunk);
	if (buffer.length > MAX_EVAL_FRAME_CHARS && !buffer.includes("\n")) {
		process.stderr.write("Eval kernel frame exceeded 1 MiB.\n");
		process.exit(1);
	}
	for (;;) {
		const index = buffer.indexOf("\n");
		if (index < 0) break;
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim() === "") continue;
		if (line.length > MAX_EVAL_FRAME_CHARS) {
			process.stderr.write("Eval kernel frame exceeded 1 MiB.\n");
			process.exit(1);
		}
		void handle(JSON.parse(line) as HostToChildMessage);
	}
});
process.stdin.on("end", () => {
	runtime.dispose();
	process.exit(0);
});

send({ type: "ready" });

async function handle(message: HostToChildMessage): Promise<void> {
	if (message.type === "shutdown") {
		runtime.dispose();
		process.exit(0);
	}
	if (message.type === "toolResult") {
		pendingTools.get(message.id)?.(message);
		pendingTools.delete(message.id);
		return;
	}
	if (message.type === "cancel") {
		if (active?.cellId !== message.cellId) return;
		for (const [id, settle] of pendingTools) {
			settle({
				type: "toolResult",
				id,
				ok: false,
				error: { name: "AbortError", message: "Eval was aborted." },
			});
			pendingTools.delete(id);
		}
		runtime.clearTimers();
		active.abort.abort();
		return;
	}
	if (message.type !== "execute") return;
	process.chdir(SESSION_CWD);
	const abort = new AbortController();
	active = { cellId: message.cellId, abort };
	try {
		const value = await runtime.runWithHooks(
			message.code,
			{
				cwd: SESSION_CWD,
				onText: (text) => send({ type: "text", cellId: message.cellId, text }),
				onDisplay: (display) =>
					send({ type: "display", cellId: message.cellId, value: cloneValue(display) }),
				callTool: (name, args) => callTool(message.cellId, name, args),
			},
			abort.signal,
		);
		send({ type: "done", cellId: message.cellId, ok: true, value: cloneValue(value) });
	} catch (error) {
		send({
			type: "done",
			cellId: message.cellId,
			ok: false,
			error: errorText(error),
		});
	} finally {
		if (active?.cellId === message.cellId) active = undefined;
	}
}

function callTool(cellId: string, name: string, args: unknown): Promise<unknown> {
	const id = `${cellId}:${pendingTools.size}:${Date.now()}`;
	return new Promise((resolve, reject) => {
		pendingTools.set(id, (result) => {
			if (result.ok) {
				resolve(result.value);
				return;
			}
			if (result.error.name === "EvalToolError" && isTrace(result.error.trace)) {
				reject(new EvalToolError(result.error.trace));
				return;
			}
			reject(new Error(result.error.message));
		});
		send({ type: "toolCall", cellId, id, name, args: cloneValue(args) });
	});
}

function send(message: ChildToHostMessage): void {
	let line = JSON.stringify(message);
	if (line.length > MAX_EVAL_FRAME_CHARS) {
		const cellId = "cellId" in message ? message.cellId : (active?.cellId ?? "");
		line = JSON.stringify({
			type: "done",
			cellId,
			ok: false,
			error: "Eval kernel frame exceeded 1 MiB.",
		});
	}
	frameWrite(`${line}\n`);
}

function cloneValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {
		return String(value);
	}
}

function isTrace(value: unknown): value is ConstructorParameters<typeof EvalToolError>[0] {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		"text" in value &&
		"durationMs" in value
	);
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
	return text.length <= 4000 ? text : `${text.slice(0, 3999)}…`;
}

function stdioChunk(chunk: unknown, encoding: string | undefined): string {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array)
		return Buffer.from(chunk).toString((encoding as BufferEncoding | undefined) ?? "utf8");
	return String(chunk);
}

function startParentWatchdog(): void {
	if (process.platform === "win32") return;
	const original = process.ppid;
	if (original <= 1) return;
	setInterval(() => {
		if (process.ppid !== original) process.exit(0);
	}, 10_000);
}
