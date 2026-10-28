import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { callController, closeControllerIpc, serveControllerIpc } from "../src/controller-ipc.js";
import { createControllerSocket } from "../src/controller-socket.js";
import { child } from "./helpers/records.js";

test("a closed controller socket rejects instead of hanging", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-eof-"));
	const socketPath = join(dir, "eof.sock");
	const server = createServer((socket) => {
		socket.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	try {
		await expect(callController(socketPath, { op: "list", input: {} })).rejects.toThrow(
			"Controller closed the connection without a reply",
		);
	} finally {
		server.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("shutdown drops an open connection instead of waiting for it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-stop-"));
	const socketPath = join(dir, "stop.sock");
	const ipc = await serveControllerIpc({
		socketPath,
		parentSessionId: "01a17c90-2f44-76a4-acf8-cfdde8339251",
		manager: waitingManager(),
	});
	const held = createConnection(socketPath);
	await once(held, "connect");
	const waiting = callController(socketPath, {
		op: "delegate",
		input: { task: "hold", wait: true },
	});
	try {
		const result = await Promise.race([
			closeControllerIpc(ipc).then(() => "closed"),
			new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 500)),
		]);
		expect(result).toBe("closed");
		await expect(waiting).rejects.toThrow();
	} finally {
		held.destroy();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a multi-byte frame over 1 MiB is rejected and a status call still fits beside waiting delegations", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-frame-"));
	const socketPath = join(dir, "frame.sock");
	const ipc = await serveControllerIpc({
		socketPath,
		parentSessionId: "01a17c90-2f44-76a4-acf8-cfdde8339252",
		manager: waitingManager(),
	});
	const oversized = createConnection(socketPath);
	oversized.on("error", () => {});
	await new Promise<void>((resolve) => oversized.once("connect", () => resolve()));
	oversized.write("€".repeat(400_000));
	await new Promise<void>((resolve) => oversized.once("close", () => resolve()));

	const outcomes: string[] = [];
	const waits = Array.from({ length: 16 }, () =>
		callController(socketPath, {
			op: "delegate",
			input: { task: "hold", wait: true },
		}).then(
			(reply) => outcomes.push(reply.ok ? "ok" : "err"),
			() => outcomes.push("err"),
		),
	);
	const started = Date.now();
	while (outcomes.length < 4) {
		if (Date.now() - started > 2_000)
			throw new Error(`waiting calls did not shed load: ${outcomes.length}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await expect(callController(socketPath, { op: "list", input: {} })).resolves.toMatchObject({
		ok: true,
		result: { children: [] },
	});
	expect(outcomes.filter((item) => item === "err").length).toBeGreaterThanOrEqual(4);
	await closeControllerIpc(ipc);
	await Promise.all(waits);
	await rm(dir, { recursive: true, force: true });
});

test("a dead controller is started again and a config error is not retried", async () => {
	let alive = false;
	let starts = 0;
	const open = createControllerSocket({
		locate: () => "/tmp/controller.sock",
		ready: async () => alive,
		start: async () => {
			starts += 1;
			alive = true;
			return "/tmp/controller.sock";
		},
	});
	await expect(open()).resolves.toBe("/tmp/controller.sock");
	expect(starts).toBe(1);
	alive = false;
	await expect(open()).resolves.toBe("/tmp/controller.sock");
	expect(starts).toBe(2);

	let failed = 0;
	const broken = createControllerSocket({
		locate: () => "/tmp/missing.sock",
		ready: async () => false,
		start: async () => {
			failed += 1;
			throw new Error("model_unavailable no model");
		},
	});
	await expect(broken()).rejects.toThrow("model_unavailable");
	expect(failed).toBe(1);
});

function waitingManager() {
	return {
		async delegate() {
			return new Promise<never>(() => undefined);
		},
		async inspect() {
			return { id: "child-1", revision: 1, status: "accepted", task: "hold", hasOutput: false };
		},
		async dashboard() {
			return { total: 0, running: 0, blocked: 0, completed: 0, failed: 0, children: [] };
		},
		async stopAgent(id: string) {
			return { id, revision: 1, status: "failed", task: "hold", hasOutput: false };
		},
		async get(id: string) {
			return child({ id });
		},
		async list() {
			return [];
		},
		async stop(id: string) {
			return child({ id, state: "done" });
		},
		async getEntries() {
			return [];
		},
	};
}
