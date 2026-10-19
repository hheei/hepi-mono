import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { BashJobRegistry, type BashJobSnapshot, MAX_RETAINED_BASH_JOBS } from "../src/bash-jobs.js";
import { BashExecutionLedger } from "../src/bash-ledger.js";
import { ledgerTemporaryDirectory } from "./fixtures/ledger-directory.js";
import { emitExit, type MockChild, mockChild } from "./fixtures/mock-child.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	mocked.spawn.mockReset();
	vi.useRealTimers();
});

function fixture() {
	const directory = ledgerTemporaryDirectory("hepi-bash-recovery-");
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, "bash.sqlite");
	const ledger = new BashExecutionLedger(file);
	cleanups.push(() => ledger.close());
	const warnings: string[] = [];
	const restore = () => {
		const jobs = new BashJobRegistry(undefined, {
			ledger,
			onError: (message) => warnings.push(message),
		});
		cleanups.push(() => jobs.dispose());
		return jobs;
	};
	return { directory, file, ledger, warnings, restore };
}

function saved(overrides: Partial<BashJobSnapshot> = {}): BashJobSnapshot {
	return {
		id: "bash-previous-1",
		command: "deploy",
		purpose: "deploy",
		cwd: process.cwd(),
		status: "running",
		exitCode: null,
		startedAt: 123,
		output: "",
		truncated: false,
		timedOut: false,
		anchor: "entry-1",
		...overrides,
	};
}

async function finish(runtime: MockChild, jobs: BashJobRegistry, id: string) {
	runtime.stdout.write("confirmed output");
	emitExit(runtime, 0);
	return jobs.waitFor(id);
}

test.each([
	"running",
	"stopping",
] as const)("restores %s as unknown, preserving evidence without executing or signalling", async (status) => {
	const current = fixture();
	const logPath = join(current.directory, "old.log");
	writeFileSync(logPath, "partial side effect\n");
	current.ledger.save(saved({ status, logPath }), false);
	const jobs = current.restore();
	expect(await jobs.waitFor("bash-previous-1")).toMatchObject({
		status: "unknown",
		exitCode: null,
		output: "partial side effect\n",
		truncated: true,
		diagnostic: expect.stringContaining("not resumed or rerun"),
	});
	expect(jobs.get("bash-previous-1")?.endedAt).toBeUndefined();
	expect(jobs.stop("bash-previous-1")?.status).toBe("unknown");
	expect(mocked.spawn).not.toHaveBeenCalled();
	expect(current.ledger.load()).toEqual([{ snapshot: saved({ status, logPath }), settled: false }]);
	expect(jobs.pendingDeliveries()).toHaveLength(1);
});

test("repeated recovery refreshes partial logs without overwriting owner evidence", async () => {
	const current = fixture();
	const logPath = join(current.directory, "growing.log");
	const evidence = saved({ status: "stopping", logPath });
	current.ledger.save(evidence, false);
	const writes = vi.spyOn(current.ledger, "save");
	const first = current.restore();
	expect(first.get(evidence.id)).toMatchObject({
		status: "unknown",
		logError: expect.stringContaining("ENOENT"),
	});
	expect(writes).not.toHaveBeenCalled();
	await first.dispose();
	writeFileSync(logPath, "later available output");
	const ledger = new BashExecutionLedger(current.file);
	const second = new BashJobRegistry(undefined, { ledger, onError: () => undefined });
	cleanups.push(() => second.dispose());
	expect(second.get(evidence.id)).toMatchObject({
		status: "unknown",
		output: "later available output",
	});
	expect(second.get(evidence.id)?.logError).toBeUndefined();
	expect(ledger.load()).toEqual([{ snapshot: evidence, settled: false }]);
	expect(mocked.spawn).not.toHaveBeenCalled();
});

test("evicted interrupted records stay unknown and redeliver after tree navigation", () => {
	const current = fixture();
	const ids = Array.from(
		{ length: MAX_RETAINED_BASH_JOBS + 1 },
		(_, index) => `bash-interrupted-${index}`,
	);
	for (const id of ids) current.ledger.save(saved({ id }), false);
	const writes = vi.spyOn(current.ledger, "save");
	const jobs = current.restore();
	jobs.reconcileRecorded(new Set(ids));
	expect(jobs.pendingDeliveries()).toEqual([]);
	expect(jobs.get(ids[0]!)).toMatchObject({ status: "unknown", exitCode: null });
	jobs.reconcileRecorded(new Set(), true);
	expect(jobs.pendingDeliveries()).toHaveLength(ids.length);
	expect(jobs.pendingDeliveries().every((event) => event.status === "unknown")).toBe(true);
	expect(writes).not.toHaveBeenCalled();
	expect(mocked.spawn).not.toHaveBeenCalled();
});

test("preserves reliable exit facts and log failures across reopen", async () => {
	const current = fixture();
	current.ledger.save(
		saved({
			status: "failed",
			exitCode: 7,
			endedAt: 456,
			output: "failure details",
			logError: "disk full",
		}),
		true,
	);
	current.ledger.close();
	const reopened = new BashExecutionLedger(current.file);
	const jobs = new BashJobRegistry(undefined, { ledger: reopened, onError: () => undefined });
	cleanups.push(() => jobs.dispose());
	expect(await jobs.waitFor("bash-previous-1")).toMatchObject({
		status: "failed",
		exitCode: 7,
		endedAt: 456,
		output: "failure details",
		logError: "disk full",
	});
	expect(mocked.spawn).not.toHaveBeenCalled();
});

test("writes intent before spawn and reliable result after output collection", async () => {
	const current = fixture();
	const jobs = current.restore();
	const runtime = mockChild();
	mocked.spawn.mockImplementationOnce(() => {
		expect(current.ledger.load()).toMatchObject([
			{ settled: false, snapshot: { command: "build", status: "running" } },
		]);
		return runtime;
	});
	const job = jobs.start({ command: "build", cwd: process.cwd(), background: true });
	await finish(runtime, jobs, job.id);
	expect(current.ledger.load()).toMatchObject([
		{
			settled: true,
			snapshot: { id: job.id, status: "completed", exitCode: 0, output: "confirmed output" },
		},
	]);
});

test("failure to persist intent prevents shell start", () => {
	const current = fixture();
	const jobs = current.restore();
	vi.spyOn(current.ledger, "save").mockImplementationOnce(() => {
		throw new Error("disk full");
	});
	expect(() => jobs.start({ command: "deploy", cwd: process.cwd(), background: true })).toThrow(
		"disk full",
	);
	expect(mocked.spawn).not.toHaveBeenCalled();
	expect(current.ledger.load()).toEqual([]);
});

test("terminal persistence failure preserves observed exit but leaves uncertain recovery evidence", async () => {
	const current = fixture();
	const jobs = current.restore();
	const runtime = mockChild();
	mocked.spawn.mockReturnValueOnce(runtime);
	const job = jobs.start({ command: "deploy", cwd: process.cwd(), background: true });
	vi.spyOn(current.ledger, "save").mockImplementationOnce(() => {
		throw new Error("disk full");
	});
	expect(await finish(runtime, jobs, job.id)).toMatchObject({
		status: "completed",
		exitCode: 0,
		endedAt: expect.any(Number),
		diagnostic: expect.stringContaining("disk full"),
	});
	expect(current.warnings).toEqual([expect.stringContaining("disk full")]);
	expect(current.ledger.load()[0]?.settled).toBe(false);
});

test("records stop intent before signalling owned runtime", async () => {
	const current = fixture();
	const jobs = current.restore();
	const runtime = mockChild();
	mocked.spawn.mockReturnValueOnce(runtime);
	const job = jobs.start({ command: "watch", cwd: process.cwd(), background: true });
	runtime.kill.mockImplementation(() => {
		expect(current.ledger.load()[0]).toMatchObject({
			settled: false,
			snapshot: { status: "stopping" },
		});
		emitExit(runtime, null, "SIGTERM");
		return true;
	});
	jobs.stop(job.id);
	expect(await jobs.waitFor(job.id)).toMatchObject({ status: "cancelled" });
});

test("teardown without exit confirmation persists unknown rather than stopped", async () => {
	vi.useFakeTimers();
	const current = fixture();
	const jobs = current.restore();
	const runtime = mockChild();
	mocked.spawn.mockReturnValueOnce(runtime);
	jobs.start({ command: "watch", cwd: process.cwd(), background: true });
	const disposed = jobs.dispose();
	await vi.advanceTimersByTimeAsync(2100);
	await disposed;
	const reopened = new BashExecutionLedger(current.file);
	cleanups.push(() => reopened.close());
	expect(reopened.load()[0]).toMatchObject({
		settled: true,
		snapshot: { status: "unknown", exitCode: null },
	});
	expect(reopened.load()[0]?.snapshot.endedAt).toBeUndefined();
});

test("historical results remain queryable after memory eviction and redeliver on another branch", async () => {
	const current = fixture();
	const jobs = current.restore();
	const ids: string[] = [];
	for (let index = 0; index <= MAX_RETAINED_BASH_JOBS; index += 1) {
		const runtime = mockChild();
		mocked.spawn.mockReturnValueOnce(runtime);
		const job = jobs.start({ command: `build ${index}`, cwd: process.cwd(), background: true });
		await finish(runtime, jobs, job.id);
		ids.push(job.id);
		jobs.markSubmitted([job.id], `batch-${index}`);
		jobs.markRecorded(`batch-${index}`);
	}
	expect(jobs.pendingDeliveries()).toEqual([]);
	expect(jobs.get(ids[0]!)).toMatchObject({ status: "completed", output: "confirmed output" });
	const loads = vi.spyOn(current.ledger, "load");
	jobs.reconcileRecorded(new Set(ids));
	expect(loads).not.toHaveBeenCalled();
	jobs.reconcileRecorded(new Set(), true);
	expect(jobs.pendingDeliveries()).toHaveLength(ids.length);
	expect(mocked.spawn).toHaveBeenCalledTimes(ids.length);
});

test("missing recovery log stays explicit and does not prevent report", () => {
	const current = fixture();
	current.ledger.save(saved({ logPath: join(current.directory, "missing.log") }), false);
	const jobs = current.restore();
	expect(jobs.pendingDeliveries()[0]).toMatchObject({
		status: "unknown",
		logError: expect.stringContaining("ENOENT"),
	});
});
