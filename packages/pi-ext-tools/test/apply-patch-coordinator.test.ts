import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	exceedsCompletedRequestBudget,
	hasCoordinatorCapacity,
	progressFrame,
	responseFrame,
} from "../src/apply-patch/coordinator-server.js";
import {
	applyPatchThroughCoordinator,
	coordinatorSocketPath,
	warmApplyPatchCoordinator,
} from "../src/apply-patch/index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-apply-patch-coordinator-"));
	temporaryPaths.push(path);
	return path;
}

async function waitForSocket(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for coordinator socket: ${path}`);
		await Bun.sleep(20);
	}
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<number | null> {
	if (child.exitCode !== null) return child.exitCode;
	return await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("admits parsing, pending, and running work within one queue budget", (): void => {
	expect(hasCoordinatorCapacity(0, 2)).toBe(true);
	expect(hasCoordinatorCapacity(1, 2)).toBe(true);
	expect(hasCoordinatorCapacity(2, 2)).toBe(false);
});

test("bounds completed replay records by count and serialized bytes", (): void => {
	expect(exceedsCompletedRequestBudget(128, 8 * 1024 * 1024)).toBe(false);
	expect(exceedsCompletedRequestBudget(129, 0)).toBe(true);
	expect(exceedsCompletedRequestBudget(1, 8 * 1024 * 1024 + 1)).toBe(true);
});

test("evicts the oldest completed replay record into a fingerprint tombstone", async (): Promise<void> => {
	const root = await temporaryDirectory();
	await warmApplyPatchCoordinator(root);
	const socket = connect(coordinatorSocketPath(root));
	socket.setEncoding("utf8");
	const replayError = await new Promise<string>((resolve, reject) => {
		let buffer = "";
		let nextRequest = 0;
		let replaying = false;
		const sendRequest = (id: string): void => {
			socket.write(
				`${JSON.stringify({
					type: "apply",
					id,
					workspaceRoot: root,
					patch: "*** Begin Patch\n",
				})}\n`,
			);
		};
		socket.once("error", reject);
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const message = JSON.parse(line) as {
					readonly id: string;
					readonly type?: string;
					readonly ok?: boolean;
					readonly error?: string;
				};
				if (message.type === "progress" || message.ok !== false || message.error === undefined)
					continue;
				if (replaying) {
					socket.end();
					resolve(message.error);
					return;
				}
				nextRequest += 1;
				if (nextRequest < 129) sendRequest(`completed-${nextRequest}`);
				else {
					replaying = true;
					sendRequest("completed-0");
				}
			}
		});
		socket.once("connect", () => sendRequest("completed-0"));
	});

	expect(replayError).toContain("outcome expired");
	expect(replayError).toContain("read affected paths");
});

test("bounds concurrent parsing before queueing work", async (): Promise<void> => {
	const root = await temporaryDirectory();
	await warmApplyPatchCoordinator(root);
	const socket = connect(coordinatorSocketPath(root));
	socket.setEncoding("utf8");
	const response = await new Promise<{
		readonly id: string;
		readonly ok: boolean;
		readonly error?: string;
	}>((resolve, reject) => {
		let buffer = "";
		socket.once("error", reject);
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const message = JSON.parse(line) as {
					readonly id: string;
					readonly type?: string;
					readonly ok: boolean;
					readonly error?: string;
				};
				if (message.type === "progress" || message.id !== "parsing-32") continue;
				socket.end();
				resolve(message);
				return;
			}
		});
		socket.once("connect", () => {
			const request = (id: string): string =>
				`${JSON.stringify({
					type: "apply",
					id,
					workspaceRoot: root,
					patch: "*** Begin Patch\n*** Add File: preview.txt\n+preview\n",
				})}\n`;
			socket.write(Array.from({ length: 33 }, (_, index) => request(`parsing-${index}`)).join(""));
		});
	});

	expect(response).toEqual({
		id: "parsing-32",
		ok: false,
		error: "Apply patch coordinator queue is full",
	});
	await expect(readFile(join(root, "preview.txt"), "utf8")).rejects.toThrow();
});

test("prewarms a workspace coordinator before its first patch", async (): Promise<void> => {
	const root = await temporaryDirectory();
	await warmApplyPatchCoordinator(root);

	const result = await applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch: "*** Begin Patch\n*** Add File: warmed.txt\n+warmed\n*** End Patch",
	});

	expect(result.changedPaths).toEqual(["warmed.txt"]);
	expect(await readFile(join(root, "warmed.txt"), "utf8")).toBe("warmed\n");
});

test("starts one local coordinator and applies its V4A request", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const result = await applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch",
	});

	expect(result).toMatchObject({
		changedPaths: ["created.txt"],
		operationCount: 1,
		exactUpdateCount: 0,
		fuzzyUpdateCount: 0,
	});
	expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created\n");
});

test("uses a revisioned coordinator socket path", (): void => {
	const current = coordinatorSocketPath("/tmp/workspace");
	const revision2 =
		"/tmp/hepi-apply-patch-89b427c905a5ab408be624b6911f0a31b171ed8e675fac137b447a4edd1ab422.sock";
	const revision3 =
		"/tmp/hepi-apply-patch-984b6201068741878bb3cea406f8384217d978684ee7787710307874256079a1.sock";
	const revision4 =
		"/tmp/hepi-apply-patch-c2bcf84ab433eb0002962f7910fd2f7786f75c83a4ad590a4139a92606c3f98c.sock";
	expect(current).toMatch(/hepi-apply-patch-[a-f0-9]{64}\.sock$/);
	expect(current).not.toBe(revision2);
	expect(current).not.toBe(revision3);
	expect(current).not.toBe(revision4);
});

test("deduplicates the same request id while the first request is parsing", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const options = {
		workspaceRoot: root,
		requestId: "concurrent-request",
		patch: "*** Begin Patch\n*** Add File: concurrent.txt\n+created\n*** End Patch",
	};
	const [first, second] = await Promise.all([
		applyPatchThroughCoordinator(options),
		applyPatchThroughCoordinator(options),
	]);

	expect(second).toEqual(first);
	expect(await readFile(join(root, "concurrent.txt"), "utf8")).toBe("created\n");
});

test("compacts successful responses when snapshots exceed the response budget", (): void => {
	const response = {
		id: "large-result",
		ok: true,
		result: {
			changedPaths: ["large.txt"],
			addedLines: 1,
			removedLines: 0,
			operations: [],
			operationCount: 1,
			exactUpdateCount: 0,
			fuzzyUpdateCount: 0,
			applied: [
				{
					operationIndex: 0,
					kind: "update",
					paths: ["large.txt"],
					outcomes: [],
					snapshots: Array.from({ length: 50_000 }, () => ({
						path: "large.txt",
						hunkIndex: 1,
						startLine: 1,
						afterStartLine: 1,
						before: ["before"],
						after: ["after"],
					})),
				},
			],
			rejected: [],
		},
	} as Parameters<typeof responseFrame>[0];
	const frame = responseFrame(response);
	const decoded = JSON.parse(frame) as typeof response;

	expect(decoded.ok).toBe(true);
	if (!decoded.ok) throw new Error(decoded.error);
	expect(decoded.result.applied[0]?.snapshots).toEqual([]);
});

test("compacts oversized progress frames without dropping the request", (): void => {
	const progress = {
		stage: "staging" as const,
		files: 10,
		addedLines: 3,
		removedLines: 1,
		operations: Array.from({ length: 10 }, (_, operationIndex) => ({
			operationIndex,
			kind: "update" as const,
			path: `file-${operationIndex}.txt`,
			addedLines: 3,
			removedLines: 1,
			status: "partial" as const,
			appliedHunks: 2,
			totalHunks: 3,
			partialReason: "x".repeat(120_000),
		})),
	};
	const frame = progressFrame("large-progress", progress);
	if (frame === undefined) throw new Error("Expected compact progress frame");
	const decoded = JSON.parse(frame) as {
		readonly progress: { readonly operations: readonly { readonly partialReason?: string }[] };
	};

	expect(decoded.progress.operations).toHaveLength(10);
	expect(decoded.progress.operations[0]?.partialReason).toBeUndefined();
});

test("cancels a request while parsing before it enters the queue", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const controller = new AbortController();
	const patch =
		"*** Begin Patch\n" +
		Array.from({ length: 32 }, (_, index) => `*** Add File: parsed-${index}.txt\n+value\n`).join(
			"",
		) +
		"*** End Patch";
	const request = applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch,
		signal: controller.signal,
		onProgress: (progress) => {
			if (progress.stage === "parsed") controller.abort(new Error("cancelled during parsing"));
		},
	});

	await expect(request).rejects.toThrow("Apply patch cancelled by client during parsing");
	await expect(readFile(join(root, "parsed-0.txt"), "utf8")).rejects.toThrow();
});

test("drains active rollback before exiting on SIGTERM", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const modulePath = fileURLToPath(
		new URL(`../src/apply-patch/coordinator-server.${extension}`, import.meta.url),
	);
	const child = spawn(process.execPath, [modulePath, root], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	try {
		const socketPath = coordinatorSocketPath(root);
		await waitForSocket(socketPath);
		const socket = connect(socketPath);
		socket.setEncoding("utf8");
		const terminal = await new Promise<{ readonly ok: boolean; readonly error?: string }>(
			(resolve, reject) => {
				let buffer = "";
				let terminated = false;
				socket.once("error", reject);
				socket.on("data", (chunk: string) => {
					buffer += chunk;
					while (true) {
						const newline = buffer.indexOf("\n");
						if (newline < 0) return;
						const line = buffer.slice(0, newline);
						buffer = buffer.slice(newline + 1);
						const message = JSON.parse(line) as {
							readonly type?: string;
							readonly ok?: boolean;
							readonly error?: string;
							readonly progress?: { readonly stage?: string };
						};
						if (message.type === "progress") {
							if (!terminated && message.progress?.stage === "committed") {
								terminated = true;
								child.kill("SIGTERM");
								child.kill("SIGTERM");
							}
							continue;
						}
						if (message.ok !== undefined) {
							resolve({
								ok: message.ok,
								...(message.error === undefined ? {} : { error: message.error }),
							});
							return;
						}
					}
				});
				socket.once("connect", () => {
					socket.write(
						`${JSON.stringify({
							type: "apply",
							id: "sigterm-rollback",
							workspaceRoot: root,
							patch:
								"*** Begin Patch\n" +
								"*** Add File: nested/first.txt\n+first\n" +
								"*** Add File: nested/second.txt\n+second\n" +
								"*** End Patch",
						})}\n`,
					);
				});
			},
		);
		expect(terminal.ok).toBe(false);
		expect(terminal.error).toContain("cancelled");
		expect(await waitForChildExit(child)).toBe(0);
		await expect(stat(join(root, "nested"))).rejects.toThrow();
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await waitForChildExit(child).catch(() => undefined);
		if (stderr.length > 0) process.stderr.write(stderr);
	}
});

test("accepts multiple individually valid near-limit frames in one write", async (): Promise<void> => {
	const root = await temporaryDirectory();
	await warmApplyPatchCoordinator(root);
	const socket = connect(coordinatorSocketPath(root));
	socket.setEncoding("utf8");
	const received = await new Promise<readonly string[]>((resolve, reject) => {
		const ids: string[] = [];
		let buffer = "";
		socket.once("error", reject);
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const message = JSON.parse(line) as {
					readonly id: string;
					readonly ok?: boolean;
					readonly type?: string;
				};
				if (message.type === "progress") continue;
				if (message.ok !== true) {
					reject(new Error(`Unexpected coordinator response for ${message.id}`));
					return;
				}
				ids.push(message.id);
				if (ids.length === 2) {
					socket.end();
					resolve(ids);
					return;
				}
			}
		});
		socket.once("connect", () => {
			const content = "x".repeat(500_000);
			const request = (id: string, path: string): string =>
				`${JSON.stringify({
					type: "apply",
					id,
					workspaceRoot: root,
					patch: `*** Begin Patch\n*** Add File: ${path}\n+${content}\n*** End Patch`,
				})}\n`;
			socket.write(
				`${request("near-limit-first", "first.txt")}${request("near-limit-second", "second.txt")}`,
			);
		});
	});

	expect([...received].sort()).toEqual(["near-limit-first", "near-limit-second"]);
	expect((await readFile(join(root, "first.txt"), "utf8")).length).toBe(500_001);
	expect((await readFile(join(root, "second.txt"), "utf8")).length).toBe(500_001);
});

test("returns multiple final responses on one coordinator connection", async (): Promise<void> => {
	const root = await temporaryDirectory();
	await warmApplyPatchCoordinator(root);
	const socket = connect(coordinatorSocketPath(root));
	socket.setEncoding("utf8");
	const responses = await new Promise<readonly { readonly id: string; readonly ok: boolean }[]>(
		(resolve, reject) => {
			const received: { readonly id: string; readonly ok: boolean }[] = [];
			let buffer = "";
			socket.once("error", reject);
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					const message = JSON.parse(line) as {
						readonly type?: string;
						readonly id: string;
						readonly ok?: boolean;
					};
					if (message.type === "progress") continue;
					if (message.ok !== true) {
						reject(new Error(`Unexpected coordinator response for ${message.id}`));
						return;
					}
					received.push({ id: message.id, ok: message.ok });
					if (received.length === 2) {
						socket.end();
						resolve(received);
						return;
					}
				}
			});
			socket.once("connect", () => {
				socket.write(
					`${JSON.stringify({
						type: "apply",
						id: "multiplex-first",
						workspaceRoot: root,
						patch: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** End Patch",
					})}\n${JSON.stringify({
						type: "apply",
						id: "multiplex-second",
						workspaceRoot: root,
						patch: "*** Begin Patch\n*** Add File: second.txt\n+second\n*** End Patch",
					})}\n`,
				);
			});
		},
	);

	expect(responses.map((response) => response.id).sort()).toEqual([
		"multiplex-first",
		"multiplex-second",
	]);
	expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first\n");
	expect(await readFile(join(root, "second.txt"), "utf8")).toBe("second\n");
});

test("returns a cached outcome when the request id is retried", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const options = {
		workspaceRoot: root,
		requestId: "replayed-request",
		patch: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch",
	};
	const first = await applyPatchThroughCoordinator(options);
	const second = await applyPatchThroughCoordinator(options);

	expect(second).toMatchObject({
		changedPaths: first.changedPaths,
		addedLines: first.addedLines,
		removedLines: first.removedLines,
		operations: first.operations,
		operationCount: first.operationCount,
	});
	expect(second.applied[0]?.snapshots).toEqual([]);
	expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created\n");
});

test("rejects malformed envelopes without validating or applying previewed operations", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const invalid = applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch: "*** Begin Patch\n*** Add File: preview.txt\n+preview\n",
	});
	await expect(invalid).rejects.toThrow("1 parsed preview operation was shown");
	await expect(invalid).rejects.toThrow("no operations were validated or applied");
	await expect(readFile(join(root, "preview.txt"), "utf8")).rejects.toThrow();
});

test("reports parsed operations before workspace validation and apply", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const progress: Parameters<
		NonNullable<Parameters<typeof applyPatchThroughCoordinator>[0]["onProgress"]>
	>[0][] = [];
	await applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch:
			"*** Begin Patch\n" +
			"*** Add File: first.txt\n+one\n" +
			"*** Add File: second.txt\n+two\n" +
			"*** End Patch",
		onProgress: (update) => progress.push(update),
	});
	expect(progress.map((update) => update.stage)).toEqual(
		expect.arrayContaining(["parsed", "queued", "staging", "committed"]),
	);
	expect(progress[0]).toMatchObject({
		files: 1,
		addedLines: 0,
		removedLines: 0,
		operations: [{ kind: "add", path: "first.txt", status: "pending" }],
	});
	expect(progress[1]).toMatchObject({
		files: 2,
		addedLines: 0,
		removedLines: 0,
		operations: [
			{ kind: "add", path: "first.txt", status: "pending" },
			{ kind: "add", path: "second.txt", status: "pending" },
		],
	});
});

test("returns accepted and rejected operations independently", async (): Promise<void> => {
	const root = await temporaryDirectory();
	await writeFile(join(root, "existing.txt"), "existing\n", "utf8");

	const result = await applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch:
			"*** Begin Patch\n" +
			"*** Add File: created.txt\n+created\n" +
			"*** Add File: existing.txt\n+replacement\n" +
			"*** End Patch",
	});

	expect(result.changedPaths).toEqual(["created.txt"]);
	expect(result.rejected).toMatchObject([{ paths: ["existing.txt"] }]);
	expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created\n");
	expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("existing\n");
});
