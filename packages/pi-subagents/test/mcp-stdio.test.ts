import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { expect, test } from "vitest";
import { callController, serveControllerIpc } from "../src/controller-ipc.js";
import { createSubagentMcpServer } from "../src/mcp-server.js";
import { child } from "./helpers/records.js";

test("legacy initialize lists delegate and a tool call waits for the receipt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-mcp-"));
	const socketPath = join(dir, "controller.sock");
	const ipc = await serveControllerIpc({
		socketPath,
		parentSessionId: "01a17c90-2f44-76a4-acf8-cfdde8339243",
		statePath: join(dir, "state.sqlite"),
		manager: {
			async delegate() {
				return {
					id: "child-1",
					revision: 1,
					status: "accepted",
					task: "inspect",
					hasOutput: false,
				};
			},
			async inspect() {
				return {
					id: "child-1",
					revision: 1,
					status: "accepted",
					task: "inspect",
					hasOutput: false,
				};
			},
			async dashboard() {
				return { total: 1, running: 1, blocked: 0, completed: 0, failed: 0, children: [] };
			},
			async stopAgent() {
				return {
					id: "child-1",
					revision: 1,
					status: "failed",
					task: "inspect",
					hasOutput: false,
				};
			},
			async get(id: string) {
				return child({ id });
			},
			async list() {
				return [child({ id: "child-1", state: "running" })];
			},
			async stop(id: string) {
				return child({ id, state: "done" });
			},
			async getEntries() {
				return { entries: [{ role: "assistant", text: "done" }] };
			},
		},
	});
	const input = new PassThrough();
	const output = new PassThrough();
	let raw = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		raw += chunk;
	});
	const handle = serveStdio(() => createSubagentMcpServer(async () => socketPath, dir), {
		legacy: "serve",
		transport: new StdioServerTransport(input, output),
	});
	try {
		input.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "codex", version: "0.155.1" },
				},
			})}\n`,
		);
		input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
		await waitFor(() => raw.includes('"id":2') || raw.includes('"id": 2'));
		expect(raw).toContain('"name":"delegate"');
		expect(raw).not.toContain("model_unavailable");

		const direct = callController(socketPath, {
			op: "delegate",
			input: { task: "inspect", agent: "worker", wait: false },
		});
		await expect(direct).resolves.toMatchObject({
			ok: true,
			result: { status: "accepted", id: "child-1", revision: 1, hasOutput: false },
		});
	} finally {
		await handle.close();
		await new Promise<void>((resolve, reject) => {
			ipc.close((error) => (error === undefined ? resolve() : reject(error)));
		});
		await rm(dir, { recursive: true, force: true });
	}
});

async function waitFor(ready: () => boolean): Promise<void> {
	const started = Date.now();
	while (!ready()) {
		if (Date.now() - started > 5_000) throw new Error(`MCP stdio did not answer:\n${""}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("task and dashboard resources advertise the MCP Apps bridge", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-ui-"));
	const socketPath = join(dir, "controller.sock");
	const ipc = await serveControllerIpc({
		socketPath,
		parentSessionId: "01a17c90-2f44-76a4-acf8-cfdde8339243",
		statePath: join(dir, "state.sqlite"),
		manager: {
			async delegate() {
				return {
					id: "child-1",
					revision: 1,
					status: "accepted",
					task: "inspect",
					hasOutput: false,
				};
			},
			async inspect() {
				return {
					id: "child-1",
					revision: 1,
					status: "accepted",
					task: "inspect",
					hasOutput: false,
				};
			},
			async dashboard() {
				return { total: 1, running: 1, blocked: 0, completed: 0, failed: 0, children: [] };
			},
			async stopAgent() {
				return {
					id: "child-1",
					revision: 1,
					status: "failed",
					task: "inspect",
					hasOutput: false,
				};
			},
			async get(id: string) {
				return child({ id, activeTool: "vitest" });
			},
			async list() {
				return [child({ id: "child-1", state: "running" })];
			},
			async stop(id: string) {
				return child({ id, state: "done" });
			},
			async getEntries() {
				return {
					entries: [
						{ type: "message", text: "hello" },
						{ type: "message", text: "world" },
					],
				};
			},
		},
	});
	const input = new PassThrough();
	const output = new PassThrough();
	let raw = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		raw += chunk;
	});
	const handle = serveStdio(() => createSubagentMcpServer(async () => socketPath, dir), {
		legacy: "serve",
		transport: new StdioServerTransport(input, output),
	});
	const send = (message: unknown): void => {
		input.write(`${JSON.stringify(message)}\n`);
	};
	try {
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "codex", version: "0.155.1" },
			},
		});
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		send({
			jsonrpc: "2.0",
			id: 3,
			method: "resources/read",
			params: { uri: "ui://hheei/subagents/task" },
		});
		send({
			jsonrpc: "2.0",
			id: 4,
			method: "resources/read",
			params: { uri: "ui://hheei/subagents/dashboard" },
		});
		await waitFor(() => raw.includes('"id":4') || raw.includes('"id": 4'));
		expect(raw).toContain("ui://hheei/subagents/task");
		expect(raw).toContain("ui://hheei/subagents/dashboard");
		expect(raw).toContain("text/html;profile=mcp-app");
		expect(raw).toContain("ui/initialize");
		expect(raw).toContain('"name":"get"');
		expect(raw).toContain('"name":"stop"');
		const listed = raw
			.split("\n")
			.find((line) => line.includes('"id":2') || line.includes('"id": 2'));
		expect(listed).toBeDefined();
		const tools = JSON.parse(listed ?? "{}") as {
			result?: { tools?: Array<{ name: string; _meta?: { ui?: { visibility?: string[] } } }> };
		};
		const names = tools.result?.tools?.map((tool) => tool.name) ?? [];
		expect(names).toEqual(
			expect.arrayContaining([
				"delegate",
				"get",
				"stop",
				"dashboard",
				"list",
				"transcript",
				"catalog",
				"receipts",
			]),
		);
		expect(names.some((name) => name.startsWith("subagents_"))).toBe(false);
		const get = tools.result?.tools?.find((tool) => tool.name === "get");
		expect(get?._meta?.ui?.visibility).toEqual(["model", "app"]);
		const list = tools.result?.tools?.find((tool) => tool.name === "list");
		expect(list?._meta?.ui?.visibility).toEqual(["app"]);
		const delegate = tools.result?.tools?.find((tool) => tool.name === "delegate");
		expect(delegate?._meta?.ui).toMatchObject({ resourceUri: "ui://hheei/subagents/task" });
		const dashboard = tools.result?.tools?.find((tool) => tool.name === "dashboard");
		expect(dashboard?._meta?.ui).toMatchObject({ resourceUri: "ui://hheei/subagents/dashboard" });
	} finally {
		await handle.close();
		await new Promise<void>((resolve, reject) => {
			ipc.close((error) => (error === undefined ? resolve() : reject(error)));
		});
		await rm(dir, { recursive: true, force: true });
	}
});
