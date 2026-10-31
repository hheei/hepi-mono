import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBackgroundDelivery, isRecord } from "@hheei/pi-ext-core";
import { afterEach, expect, test, vi } from "vitest";
import {
	BASH_TERMINAL_CUSTOM_TYPE,
	MAX_NOTIFICATION_BATCH_BYTES,
	startBashDelivery,
} from "../src/bash-delivery.js";
import { BASH_IDLE_NOTICE_MS, BashJobRegistry } from "../src/bash-jobs.js";
import { BashExecutionLedger } from "../src/bash-ledger.js";
import { toolHost } from "./fixtures/harness.js";
import { ledgerTemporaryDirectory } from "./fixtures/ledger-directory.js";
import { emitExit, type MockChild, mockChild } from "./fixtures/mock-child.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));

interface SentMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: unknown;
	readonly details: unknown;
	readonly options: unknown;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.useRealTimers();
});

function harness(
	options: {
		readonly branch?: readonly string[];
		readonly signal?: AbortSignal;
		readonly jobs?: BashJobRegistry;
		readonly reports?: readonly { id: string; details: unknown }[];
	} = {},
) {
	const sent: SentMessage[] = [];
	const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();
	const warnings: string[] = [];
	const handlers = new Map<string, Set<(payload: unknown) => void>>();
	let failure: Error | undefined;
	let synchronousObservation = false;
	let branch: readonly string[] = options.branch ?? [];
	let idle = true;
	let sequence = 0;
	const entries = new Map<string, { type: string; customType?: string; details?: unknown }>(
		(options.reports ?? []).map((report) => [
			report.id,
			{ type: "custom_message", customType: BASH_TERMINAL_CUSTOM_TYPE, details: report.details },
		]),
	);
	const emit = (type: string, payload: unknown): void => {
		if (
			type === "message_end" &&
			isRecord(payload) &&
			isRecord(payload.message) &&
			payload.message.role === "custom"
		) {
			const id = `report-${++sequence}`;
			entries.set(id, {
				type: "custom_message",
				customType: String(payload.message.customType),
				details: payload.message.details,
			});
			branch = [...branch, id];
		}
		for (const handler of handlers.get(type) ?? []) handler(payload);
	};
	const host = {
		events: {},
		appendEntry,
		sendMessage(message: unknown, sendOptions: unknown): void {
			if (failure !== undefined) {
				const rejected = failure;
				failure = undefined;
				throw rejected;
			}
			if (
				!isRecord(message) ||
				typeof message.customType !== "string" ||
				typeof message.content !== "string"
			)
				throw new Error("Expected custom message");
			sent.push({
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				options: sendOptions,
			});
			if (synchronousObservation) emit("message_end", { message: { ...message, role: "custom" } });
		},
		on(type: string, handler: (payload: unknown) => void): () => void {
			const subscribers = handlers.get(type) ?? new Set();
			subscribers.add(handler);
			handlers.set(type, subscribers);
			return () => {
				subscribers.delete(handler);
			};
		},
	};
	const pi = Object.assign(toolHost().pi, host);
	let branchReads = 0;
	const session = {
		isIdle: () => idle,
		sessionManager: {
			getBranch: () => {
				branchReads += 1;
				return branch.map((id) => ({ id, ...entries.get(id) }));
			},
		},
	} as ExtensionContext;
	const jobs = options.jobs ?? new BashJobRegistry(128 * 1024);
	const stop = startBashDelivery({
		pi,
		jobs,
		session,
		...(options.signal === undefined ? {} : { signal: options.signal }),
		notify: (message) => warnings.push(message),
	});
	const children: MockChild[] = [];
	const directories: string[] = [];
	function start(command = "build", anchor?: string, logged = false) {
		const child = mockChild();
		mocked.spawn.mockReturnValueOnce(child);
		const logDir = logged ? ledgerTemporaryDirectory("pi-delivery-") : undefined;
		if (logDir !== undefined) directories.push(logDir);
		const job = jobs.start({
			command,
			cwd: process.cwd(),
			background: true,
			...(anchor === undefined ? {} : { anchor }),
			...(logDir === undefined
				? {}
				: { resolveLogPath: (id: string) => join(logDir, `${id}.log`) }),
		});
		children.push(child);
		return { child, job };
	}
	async function finish(
		started: ReturnType<typeof start>,
		output = "done",
		exitCode = 0,
	): Promise<void> {
		started.child.stdout.write(output);
		emitExit(started.child, exitCode);
		await jobs.waitFor(started.job.id);
		await Promise.resolve();
	}
	cleanups.push(async () => {
		stop();
		for (const child of children) {
			if (child.exited) continue;
			emitExit(child, 0);
		}
		await jobs.dispose();
		for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	});
	return {
		pi,
		jobs,
		sent,
		appendEntry,
		warnings,
		stop,
		start,
		finish,
		emit,
		isIdle: () => idle,
		failNextSend(error: Error) {
			failure = error;
		},
		observeSynchronously() {
			synchronousObservation = true;
		},
		branch: () => branch,
		branchReads: () => branchReads,
		setBranch(value: readonly string[]) {
			branch = value;
			emit("session_tree", {});
		},
		record(index: number) {
			const message = sent[index];
			if (message === undefined) throw new Error("Missing sent message");
			emit("message_end", {
				message: { role: "custom", customType: message.customType, details: message.details },
			});
		},
		setIdle(value: boolean) {
			idle = value;
		},
	};
}

test("reconciles recovered reports against raw current branch receipts and redelivers on eligible branch", async () => {
	const directory = ledgerTemporaryDirectory("pi-delivery-recovery-");
	const ledger = new BashExecutionLedger(join(directory, "bash.sqlite"));
	ledger.save(
		{
			id: "bash-restored",
			command: "build",
			purpose: "build",
			cwd: process.cwd(),
			status: "completed",
			exitCode: 0,
			startedAt: 1,
			endedAt: 2,
			timedOut: false,
			output: "restored result",
			truncated: false,
			anchor: "entry-1",
		},
		true,
	);
	const jobs = new BashJobRegistry(undefined, { ledger, onError: () => undefined });
	const receipt = {
		batch: "old-batch",
		jobs: [
			{
				jobId: "bash-restored",
				purpose: "build",
				status: "completed",
				exitCode: 0,
				truncated: false,
			},
		],
	};
	const current = harness({
		jobs,
		branch: ["entry-1", "receipt-1", "compaction-1"],
		reports: [{ id: "receipt-1", details: receipt }],
	});
	cleanups.push(async () => {
		await jobs.dispose();
		ledger.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	expect(jobs.pendingDeliveries()).toEqual([]);
	current.setBranch(["entry-1", "branch-b"]);
	await Promise.resolve();
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("restored result");
	current.record(0);
	expect(jobs.pendingDeliveries()).toEqual([]);
	current.setBranch(["entry-1", "receipt-1"]);
	await Promise.resolve();
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
});

test("startup automatically reports an uncertain restored execution with partial-log warning", async () => {
	const directory = ledgerTemporaryDirectory("pi-delivery-unknown-");
	const ledger = new BashExecutionLedger(join(directory, "bash.sqlite"));
	ledger.save(
		{
			id: "bash-uncertain",
			command: "deploy",
			purpose: "deploy",
			cwd: process.cwd(),
			status: "stopping",
			exitCode: null,
			startedAt: 1,
			timedOut: false,
			output: "partial output",
			truncated: false,
			logPath: join(directory, "missing.log"),
		},
		false,
	);
	const jobs = new BashJobRegistry(undefined, { ledger, onError: () => undefined });
	const current = harness({ jobs });
	cleanups.push(async () => {
		await jobs.dispose();
		ledger.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("unknown outcome");
	expect(current.sent[0]?.content).toContain("not resumed or rerun");
	expect(current.sent[0]?.content).toContain("Check side effects");
	expect(current.sent[0]?.content).toContain("Available log (may be incomplete)");
	expect(current.sent[0]?.content).toContain("partial output");
	expect(current.sent[0]?.options).toMatchObject({ triggerTurn: true });
});

test.each([
	true,
	false,
])("delivers completed Bash immediately while unrelated command runs (idle=%s)", async (idle) => {
	const current = harness();
	current.setIdle(idle);
	current.start("still running");
	const ready = current.start("ready");
	await current.finish(ready, "ready output");
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]).toMatchObject({
		customType: BASH_TERMINAL_CUSTOM_TYPE,
		display: false,
		content: expect.stringContaining("ready output"),
		options: { deliverAs: "steer", triggerTurn: true },
	});
	expect(current.appendEntry).toHaveBeenCalledWith(
		"bg-bash-info",
		expect.objectContaining({
			id: ready.job.id,
			kind: "terminal",
			message: expect.stringContaining("ready output"),
		}),
	);
	expect(current.jobs.pendingDeliveries().map((event) => event.id)).not.toContain(ready.job.id);
	current.emit("agent_settled", {});
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
});

test("failed command keeps its exit diagnostic and partial output in automatic report", async () => {
	const current = harness();
	const failed = current.start("failing build");
	await current.finish(failed, "output before failure", 7);
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("output before failure");
	expect(current.sent[0]?.content).toContain("exit 7");
	expect(current.jobs.get(failed.job.id)?.status).toBe("failed");
});

test("host message lifecycle confirms delivery, including synchronous observation", async () => {
	const current = harness();
	const observed = vi.spyOn(current.jobs, "markRecorded");
	const ready = current.start();
	await current.finish(ready);
	const details = current.sent[0]?.details;
	current.emit("message_end", { message: { role: "custom", customType: "other", details } });
	expect(current.jobs.pendingDeliveries().map((event) => event.id)).not.toContain(ready.job.id);
	current.emit("message_end", {
		message: { role: "custom", customType: BASH_TERMINAL_CUSTOM_TYPE, details },
	});
	expect(observed).toHaveBeenCalledTimes(1);
	current.observeSynchronously();
	const next = current.start("second");
	await current.finish(next);
	expect(observed).toHaveBeenCalledTimes(2);
});

test("UI failure does not requeue an accepted model report", async () => {
	const current = harness();
	current.appendEntry.mockImplementationOnce(() => {
		throw new Error("UI append failed");
	});
	const ready = current.start();
	await current.finish(ready);
	expect(current.sent).toHaveLength(1);
	expect(current.jobs.pendingDeliveries()).toEqual([]);
	expect(current.warnings).toEqual([expect.stringContaining("UI append failed")]);
	current.emit("agent_settled", {});
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
});

test("synchronous refusal keeps result pending and later lifecycle retries without duplicate notification", async () => {
	const current = harness();
	const ready = current.start();
	current.failNextSend(new Error("host refused"));
	await current.finish(ready, "kept output");
	expect(current.sent).toHaveLength(0);
	expect(current.jobs.pendingDeliveries().map((event) => event.id)).toContain(ready.job.id);
	expect(current.warnings).toEqual([expect.stringContaining("host refused")]);
	current.failNextSend(new Error("still unavailable"));
	current.emit("agent_start", {});
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	expect(current.warnings).toHaveLength(1);
	current.emit("agent_settled", {});
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("kept output");
	current.emit("agent_settled", {});
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
});

test("branch navigation holds anchored output, announces once, then resumes on its ancestor", async () => {
	const current = harness({ branch: ["elsewhere"] });
	const ready = current.start("anchored", "origin");
	await current.finish(ready, "branch output");
	expect(current.sent).toHaveLength(0);
	expect(current.jobs.pendingDeliveries().map((event) => event.id)).toContain(ready.job.id);
	expect(current.warnings).toHaveLength(1);
	expect(current.warnings[0]).toContain("another branch");
	current.emit("agent_settled", {});
	await Promise.resolve();
	expect(current.warnings).toHaveLength(1);
	current.setBranch(["origin", "descendant"]);
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("branch output");
});

test("tree retries an unrecorded submission and ignores stale batch acknowledgements", async () => {
	const current = harness({ branch: ["origin", "branch-a"] });
	const ready = current.start("anchored", "origin");
	await current.finish(ready, "once executed");
	expect(current.sent).toHaveLength(1);
	current.setBranch(["unrelated"]);
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.jobs.pendingDeliveries().map((event) => event.id)).toEqual([ready.job.id]);
	current.setBranch(["origin", "branch-b"]);
	await Promise.resolve();
	expect(current.sent).toHaveLength(2);
	const recorded = vi.spyOn(current.jobs, "markRecorded");
	current.record(0);
	expect(recorded).toHaveBeenCalledTimes(1);
	current.jobs.requeue((current.sent[1]?.details as { batch: string }).batch);
	expect(current.jobs.pendingDeliveries().map((event) => event.id)).toEqual([ready.job.id]);
	current.emit("agent_start", {});
	await Promise.resolve();
	expect(current.sent).toHaveLength(2);
	expect(current.jobs.pendingDeliveries()).toEqual([]);
});

test("one delivery pass reads the branch a fixed number of times, not once per pending job", async () => {
	const readsDuringOnePass = async (jobs: number): Promise<number> => {
		const current = harness({ branch: ["origin"] });
		const elsewhere = Array.from({ length: jobs }, (_, index) =>
			current.start(`job-${index}`, "other"),
		);
		await Promise.all(elsewhere.map((job) => current.finish(job, "held output")));
		expect(current.jobs.pendingDeliveries()).toHaveLength(jobs);
		const before = current.branchReads();
		current.emit("agent_settled", {});
		await Promise.resolve();
		return current.branchReads() - before;
	};

	// The pass partitions every pending result, so the old shape read the whole branch once per job
	// and once more for the receipts. Two reads: the scheduled pass and the coordinator's check.
	expect(await readsDuringOnePass(4)).toBe(2);
	expect(await readsDuringOnePass(1)).toBe(2);
});

test("a batch can deliver current output and announce output held on another branch", async () => {
	const current = harness({ branch: ["origin"] });
	const here = current.start("here", "origin");
	const elsewhere = current.start("elsewhere", "other");
	await Promise.all([
		current.finish(here, "visible"),
		current.finish(elsewhere, "other-branch secret"),
	]);
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("visible");
	expect(current.sent[0]?.content).not.toContain("other-branch secret");
	expect(current.warnings).toEqual([expect.stringContaining("another branch")]);
	expect(current.appendEntry).toHaveBeenCalledWith(
		"bg-bash-info",
		expect.objectContaining({
			id: elsewhere.job.id,
			kind: "held",
			message: expect.not.stringContaining("other-branch secret"),
		}),
	);
});

test.each(["dispose", "abort"])("%s suppresses queued Bash delivery", async (action) => {
	const controller = new AbortController();
	const current = harness({ signal: controller.signal });
	const ready = current.start();
	emitExit(ready.child, 0);
	if (action === "dispose") current.stop();
	else controller.abort();
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
});

test("multiple Bash batches and a child report share one idle wake", async () => {
	const current = harness({ branch: ["other"] });
	const delivery = getBackgroundDelivery(current.pi);
	let pending = false;
	const report = delivery.registerChannel({
		isIdle: current.isIdle,
		hasPending: () => pending,
		flush(triggerTurn) {
			pending = false;
			current.pi.sendMessage(
				{ customType: "subagent-report", content: "child done", display: false },
				{ triggerTurn, deliverAs: "steer" },
			);
		},
	});
	const ready = Array.from({ length: 10 }, (_, index) => current.start(`work ${index}`, "origin"));
	await Promise.all(ready.map((job) => current.finish(job)));
	pending = true;
	current.setBranch(["origin"]);
	report.request();
	await Promise.resolve();
	expect(current.sent.map((message) => message.customType)).toEqual([
		BASH_TERMINAL_CUSTOM_TYPE,
		BASH_TERMINAL_CUSTOM_TYPE,
		"subagent-report",
	]);
	expect(current.sent.map((message) => message.options)).toEqual([
		{ triggerTurn: false, deliverAs: "steer" },
		{ triggerTurn: false, deliverAs: "steer" },
		{ triggerTurn: true, deliverAs: "steer" },
	]);
	report.dispose();
});

test.each([
	"x",
	"界",
	"😀",
])("bounds each notification by UTF-8 bytes for %s and preserves complete log", async (glyph) => {
	const current = harness();
	const output = glyph.repeat(20_000);
	const ready = current.start("wide output", undefined, true);
	await current.finish(ready, output);
	expect(current.sent).toHaveLength(1);
	const content = current.sent[0]?.content ?? "";
	expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_NOTIFICATION_BATCH_BYTES);
	expect(content).not.toContain("�");
	const path = current.jobs.get(ready.job.id)?.logPath;
	expect(path).toBeDefined();
	expect(content).toContain(path);
	expect(readFileSync(path!, "utf8")).toBe(output);
});

test("several large results split by actual bytes with one idle wake", async () => {
	const current = harness();
	const jobs = Array.from({ length: 5 }, (_, index) => current.start(`work ${index}`));
	await Promise.all(jobs.map((job) => current.finish(job, "€".repeat(4000))));
	expect(current.sent.length).toBeGreaterThan(1);
	for (const message of current.sent)
		expect(Buffer.byteLength(message.content, "utf8")).toBeLessThanOrEqual(
			MAX_NOTIFICATION_BATCH_BYTES,
		);
	const joined = current.sent.map((message) => message.content).join("\n");
	for (const job of jobs) expect(joined).toContain(job.job.id);
	expect(
		current.sent.filter(
			(message) => isRecord(message.options) && message.options.triggerTurn === true,
		),
	).toHaveLength(1);
});

test("stop suppresses an idle reminder already queued for delivery", async () => {
	vi.useFakeTimers();
	const current = harness();
	const running = current.start("quiet");
	vi.advanceTimersByTime(BASH_IDLE_NOTICE_MS);
	current.jobs.stop(running.job.id);
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	await current.finish(running, "final output");
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("final output");
});

test("reminder respects branch, retries rejection and never consumes terminal delivery", async () => {
	vi.useFakeTimers();
	const current = harness({ branch: ["elsewhere"] });
	const running = current.start("quiet", "origin");
	await vi.advanceTimersByTimeAsync(BASH_IDLE_NOTICE_MS);
	expect(current.sent).toHaveLength(0);
	current.failNextSend(new Error("reminder refused"));
	current.setBranch(["origin"]);
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	expect(current.warnings).toEqual([expect.stringContaining("reminder refused")]);
	current.emit("agent_start", {});
	await Promise.resolve();
	expect(current.sent[0]?.content).toContain("idle for");
	expect(current.sent[0]?.display).toBe(false);
	expect(current.appendEntry).toHaveBeenCalledWith(
		"bg-bash-info",
		expect.objectContaining({ id: running.job.id, kind: "idle" }),
	);
	expect(current.jobs.pendingDeliveries()).toEqual([]);
	await current.finish(running, "finished later");
	expect(current.sent).toHaveLength(2);
	expect(current.sent[1]?.content).toContain("finished later");
});
