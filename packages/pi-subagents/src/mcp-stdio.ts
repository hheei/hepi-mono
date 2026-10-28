#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { controllerSocketPath, stopPreviousController } from "./controller.js";
import { CONTROLLER_PROTOCOL, controllerProtocol } from "./controller-ipc.js";
import { createControllerSocket } from "./controller-socket.js";
import { createSubagentMcpServer } from "./mcp-server.js";

const workspace = readWorkspace(process.argv.slice(2));
const controllerSocket = createControllerSocket({
	locate: () => controllerSocketPath(getAgentDir(), workspace),
	ready: controllerReady,
	start: () => spawnController(workspace, getAgentDir()),
});

serveStdio(() => createSubagentMcpServer(controllerSocket, workspace), { legacy: "serve" });

function readWorkspace(argv: readonly string[]): string {
	const index = argv.indexOf("--cwd");
	const value = index === -1 ? undefined : argv[index + 1];
	if (value === undefined || !value.startsWith("/")) {
		console.error("pi-subagents-mcp requires --cwd /absolute/workspace");
		process.exit(2);
	}
	return value;
}

function spawnController(cwd: string, agentDir: string): Promise<string> {
	const main = fileURLToPath(new URL("./controller-main.js", import.meta.url));
	const child = spawn(process.execPath, [main, cwd, agentDir], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = tail(stderr, chunk);
	});
	return new Promise<string>((resolve, reject) => {
		let stdout = "";
		let settled = false;
		const succeed = (path: string): void => {
			if (settled) return;
			settled = true;
			child.stdout?.off("data", onStdout);
			resolve(path);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const onStdout = (chunk: string): void => {
			if (settled) return;
			stdout = tail(stdout, chunk);
			const line = stdout.split("\n").find((item) => item.startsWith("ready "));
			if (line !== undefined) succeed(line.slice("ready ".length).trim());
		};
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", onStdout);
		child.once("exit", (code) => {
			fail(new Error(stderr.trim() || `Controller exited ${code ?? "unknown"}`));
		});
	});
}

function tail(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length > 4096 ? next.slice(-4096) : next;
}

/**
 * A controller from an earlier build answers on the same socket with a call surface this build does
 * not speak. It is replaced instead of being used, so an upgrade never keeps running old code.
 */
async function controllerReady(socketPath: string): Promise<boolean> {
	if (!(await socketReady(socketPath))) return false;
	if ((await controllerProtocol(socketPath)) === CONTROLLER_PROTOCOL) return true;
	await stopPreviousController(getAgentDir(), workspace);
	return false;
}

function socketReady(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const finish = (ready: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ready);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
