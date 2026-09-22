#!/usr/bin/env node
/**
 * Fake Pi `--mode rpc` child used by pi-subagents runner tests.
 *
 * Mirrors the real Pi RPC framing: one JSON object per line on stdout, responses
 * carry `{id, type:"response", command, success}`, events are anything else.
 * Behaviour is switched with FAKE_PI_* environment variables so tests can drive
 * timeouts, malformed responses, wrong-command answers, noisy event streams,
 * crash-on-signal paths and bounded stderr without a provider or network.
 */
import { createInterface } from "node:readline";

const env = process.env;
const ignoreCommands = new Set(
	(env.FAKE_PI_IGNORE ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value !== ""),
);
const noisyCount = Number(env.FAKE_PI_NOISY ?? "0");
const exitAfter = env.FAKE_PI_EXIT_AFTER ?? "";
const exitCode = Number(env.FAKE_PI_EXIT_CODE ?? "7");
const malformedCommand = env.FAKE_PI_MALFORMED ?? "";
const commandOverride = env.FAKE_PI_COMMAND_OVERRIDE ?? "";
const commandOverrideTo = env.FAKE_PI_COMMAND_OVERRIDE_TO ?? "abort";
const slowCommands = new Set(
	(env.FAKE_PI_SLOW ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value !== ""),
);
const slowMs = Number(env.FAKE_PI_SLOW_MS ?? "150");
const ignoreSigterm = env.FAKE_PI_IGNORE_SIGTERM === "1";
const stderrBytes = Number(env.FAKE_PI_STDERR_BYTES ?? "0");
const eventDelayMs = Number(env.FAKE_PI_EVENT_DELAY_MS ?? "0");
const sessionId = env.FAKE_PI_SESSION_ID ?? "fake-session";

const write = (value) => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};

const sessionState = () => ({
	sessionId,
	thinkingLevel: "off",
	isStreaming: env.FAKE_PI_BUSY === "1",
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	autoCompactionEnabled: false,
	messageCount: 0,
	pendingMessageCount: 0,
});

const entries = () => [
	{
		type: "message",
		id: "entry-1",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "fake answer" }],
			stopReason: "end_turn",
			usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
		},
	},
];

const handle = (command) => {
	const id = command.id;
	if (ignoreCommands.has(command.type)) return;
	if (malformedCommand === command.type) {
		write({ id, type: "response" });
		return;
	}
	const name = command.type === commandOverride ? commandOverrideTo : command.type;
	const respond = (data) => {
		const frame = {
			id,
			type: "response",
			command: name,
			success: true,
			...(data === undefined ? {} : { data }),
		};
		if (slowCommands.has(command.type)) setTimeout(() => write(frame), slowMs);
		else write(frame);
	};
	switch (command.type) {
		case "get_state":
			respond(sessionState());
			return;
		case "get_entries":
			respond({ entries: entries(), leafId: "entry-1" });
			return;
		case "get_session_stats":
			respond({
				sessionId,
				turns: 1,
				inputTokens: 3,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0.25,
			});
			return;
		case "prompt":
		case "steer":
		case "follow_up":
			respond(undefined);
			setTimeout(() => {
				write({ type: "agent_start" });
				for (let index = 0; index < noisyCount; index += 1)
					write({ type: "message_update", index });
				if (exitAfter === command.type) process.exit(exitCode);
			}, eventDelayMs);
			return;
		case "abort":
			respond(undefined);
			write({ type: "agent_end", messages: [] });
			return;
		default:
			write({
				id,
				type: "response",
				command: name,
				success: false,
				error: `unknown command: ${command.type}`,
			});
	}
};

process.stderr.write("fake-pi ready\n");
if (stderrBytes > 0) process.stderr.write(`${"x".repeat(stderrBytes)}\n`);
if (ignoreSigterm) process.on("SIGTERM", () => {});
if (env.FAKE_PI_EXIT_AFTER_MS !== undefined) {
	setTimeout(() => process.exit(exitCode), Number(env.FAKE_PI_EXIT_AFTER_MS));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
	if (line.trim() === "") return;
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		process.stderr.write("fake-pi: ignored malformed command line\n");
		return;
	}
	if (typeof command !== "object" || command === null) return;
	handle(command);
});
