import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type MountProbeResult,
	SessionManager,
	sanitizeHostForSocket,
} from "../src/session-manager.js";
import { clampTimeoutSeconds, executeSshExec } from "../src/ssh-exec.js";

let tmpRoot: string;
let fakeSshPath: string;
let fakeLogPath: string;

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "ssh-exec-test-"));
	fakeSshPath = join(tmpRoot, "fake-ssh.ts");
	fakeLogPath = join(tmpRoot, "ssh.log");
	await writeFile(fakeSshPath, fakeSshSource(fakeLogPath));
	await chmod(fakeSshPath, 0o755);
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

test("executeSshExec establishes control-master and reuses host session", async () => {
	const controlDir = join(tmpRoot, "control-master");
	const manager = new SessionManager({ sshBin: fakeSshPath, controlDir });

	const first = await executeSshExec(manager, { host: "prod", command: "say-hello", timeout: 5 });
	const second = await executeSshExec(manager, { host: "prod", command: "say-hello", timeout: 5 });

	expect(first).toMatchObject({
		host: "prod",
		exitCode: 0,
		stdout: "hello\n",
		stderr: "warn\n",
		truncated: false,
	});
	expect(second.exitCode).toBe(0);
	expect((await stat(controlDir)).mode & 0o777).toBe(0o700);

	const events = await readFakeLog();
	expect(events.filter((event) => event.kind === "check").length).toBeGreaterThanOrEqual(2);
	expect(events.filter((event) => event.kind === "start").length).toBeGreaterThanOrEqual(1);
	expect(events.filter((event) => event.kind === "run")).toHaveLength(2);
});

test("executeSshExec returns timeout result with captured output when requested", async () => {
	const manager = new SessionManager({
		sshBin: fakeSshPath,
		controlDir: join(tmpRoot, "control-master"),
	});
	const result = await executeSshExec(
		manager,
		{ host: "prod", command: "slow-output", timeout: 2 },
		{ timeoutMode: "result" },
	);

	expect(result.exitCode).toBeNull();
	expect(result.notice).toContain("timed out");
	expect(result.stdout).toContain("before timeout");
	expect(result.stderr).toContain("<control-socket>");
	expect(result.stderr).not.toContain(tmpRoot);
});

test("executeSshExec rejects host values OpenSSH could parse as options", async () => {
	const manager = new SessionManager({
		sshBin: fakeSshPath,
		controlDir: join(tmpRoot, "control-master"),
	});
	await expect(
		executeSshExec(manager, { host: "-oProxyCommand=sh", command: "say-hello", timeout: 5 }),
	).rejects.toThrow(/must not start with '-'/i);
});

test("ensureMounted runs sshfs first time and reuses healthy mount", async () => {
	const mountDir = join(tmpRoot, "mounts");
	const mounted = new Set<string>();
	const manager = new SessionManager({
		sshBin: fakeSshPath,
		sshfsBin: fakeSshPath,
		controlDir: join(tmpRoot, "control-master"),
		mountDir,
		mountProbe: async (mountPath): Promise<MountProbeResult> => ({
			mounted: mounted.has(mountPath) || (await pathExists(join(mountPath, ".mounted"))),
			healthy: mounted.has(mountPath) || (await pathExists(join(mountPath, ".mounted"))),
		}),
		unmountMount: async (mountPath) => {
			mounted.delete(mountPath);
			await rm(join(mountPath, ".mounted"), { force: true });
			return true;
		},
	});
	const runner = async (args: string[], timeoutMs?: number) =>
		await runFakeProcess(fakeSshPath, args, timeoutMs);

	const first = await manager.ensureMounted("prod", runner);
	mounted.add(first.localPath);
	const second = await manager.ensureMounted("prod", runner);

	expect(first.status).toBe("mounted");
	expect(second.status).toBe("reused");
	expect(first.localPath).toBe(join(mountDir, sanitizeHostForSocket("prod")));
	const events = await readFakeLog();
	expect(events.filter((event) => event.kind === "mount")).toHaveLength(1);
});

test("ensureMounted remounts stale mount and closeAll unmounts best-effort", async () => {
	const mountDir = join(tmpRoot, "mounts");
	const unmounted: string[] = [];
	const mountState = new Map<string, MountProbeResult>();
	const manager = new SessionManager({
		sshBin: fakeSshPath,
		sshfsBin: fakeSshPath,
		controlDir: join(tmpRoot, "control-master"),
		mountDir,
		mountProbe: async (mountPath) =>
			mountState.get(mountPath) ??
			((await pathExists(join(mountPath, ".mounted")))
				? { mounted: true, healthy: true }
				: { mounted: false, healthy: false }),
		unmountMount: async (mountPath) => {
			unmounted.push(mountPath);
			mountState.delete(mountPath);
			return true;
		},
	});
	const runner = async (args: string[], timeoutMs?: number) =>
		await runFakeProcess(fakeSshPath, args, timeoutMs);

	const mountPath = manager.getMountPath("prod");
	mountState.set(mountPath, { mounted: true, healthy: false });
	const result = await manager.ensureMounted("prod", runner);

	expect(result.status).toBe("remounted");
	expect(unmounted).toContain(mountPath);

	await manager.closeAll(runner);
	expect(unmounted).toContain(mountPath);
});

test("ensureMounted errors clearly when sshfs binary is missing", async () => {
	const manager = new SessionManager({
		sshBin: fakeSshPath,
		sshfsBin: join(tmpRoot, "missing-sshfs"),
		controlDir: join(tmpRoot, "control-master"),
		mountDir: join(tmpRoot, "mounts"),
	});
	const runner = async (args: string[], timeoutMs?: number) =>
		await runFakeProcess(fakeSshPath, args, timeoutMs);
	await expect(manager.ensureMounted("prod", runner)).rejects.toThrow(/sshfs binary not found/i);
});

test("ensureMounted rejects unsupported local platforms", async () => {
	const manager = new SessionManager({
		sshBin: fakeSshPath,
		sshfsBin: fakeSshPath,
		controlDir: join(tmpRoot, "control-master"),
		mountDir: join(tmpRoot, "mounts"),
		platform: "win32",
	});
	const runner = async (args: string[], timeoutMs?: number) =>
		await runFakeProcess(fakeSshPath, args, timeoutMs);
	await expect(manager.ensureMounted("prod", runner)).rejects.toThrow(
		/supported only on Linux and macOS/i,
	);
});

test("clampTimeoutSeconds keeps timeouts in supported range", () => {
	expect(clampTimeoutSeconds(undefined)).toBe(10);
	expect(clampTimeoutSeconds(0.1)).toBe(1);
	expect(clampTimeoutSeconds(99999)).toBe(3600);
});

test("clampTimeoutSeconds reads default timeout from environment", async () => {
	await withEnv({ SSH_EXEC_COMMAND_TIMEOUT_SECONDS: "42" }, async () => {
		expect(clampTimeoutSeconds(undefined)).toBe(42);
	});
});

test("SessionManager defaults give SSH master setup up to 30 seconds total", async () => {
	const timeouts: number[] = [];
	const manager = new SessionManager({
		sshBin: fakeSshPath,
		controlDir: join(tmpRoot, "control-master"),
	});
	const runner = async (args: string[], timeoutMs?: number) => {
		timeouts.push(timeoutMs ?? -1);
		if (args.includes("-O") && args.includes("check")) {
			return { exitCode: 255, stdout: "", stderr: "No ControlMaster" };
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	};

	await manager.ensureConnected("prod", runner);

	expect(manager.connectTimeoutSeconds).toBe(30);
	expect(manager.serverAliveIntervalSeconds).toBe(300);
	expect(manager.serverAliveCountMax).toBe(3);
	expect(timeouts).toHaveLength(2);
	expect(timeouts[0]).toBe(10_000);
	expect(timeouts[1]).toBeGreaterThan(20_000);
	expect(timeouts[1]).toBeLessThanOrEqual(30_000);
});

test("SessionManager reads SSH defaults from environment", async () => {
	await withEnv(
		{
			SSH_EXEC_CONTROL_PERSIST_SECONDS: "7200",
			SSH_EXEC_CONNECT_TIMEOUT_SECONDS: "12",
			SSH_EXEC_CONNECTION_ATTEMPTS: "4",
			SSH_EXEC_SERVER_ALIVE_INTERVAL_SECONDS: "60",
			SSH_EXEC_SERVER_ALIVE_COUNT_MAX: "5",
		},
		async () => {
			const manager = new SessionManager({ sshBin: fakeSshPath });

			expect(manager.controlPersist).toBe("7200");
			expect(manager.connectTimeoutSeconds).toBe(12);
			expect(manager.connectionAttempts).toBe(4);
			expect(manager.serverAliveIntervalSeconds).toBe(60);
			expect(manager.serverAliveCountMax).toBe(5);
		},
	);
});

test("SessionManager defaults mount root under ~/.cache/ssh-exec", () => {
	const manager = new SessionManager({ sshBin: fakeSshPath });
	expect(manager.getMountPath("prod")).toContain("/.cache/ssh-exec/");
});

test("ensureConnected blocks only after repeated master-start failures", async () => {
	const failingSshPath = join(tmpRoot, "fake-ssh-fail.ts");
	await writeFile(failingSshPath, failingFakeSshSource(fakeLogPath));
	await chmod(failingSshPath, 0o755);
	const manager = new SessionManager({
		sshBin: failingSshPath,
		controlDir: join(tmpRoot, "control-master"),
		failureBackoffMs: 1_000,
	});
	const runner = async (args: string[], timeoutMs?: number) =>
		await runFakeProcess(failingSshPath, args, timeoutMs);

	await expect(manager.ensureConnected("prod", runner)).rejects.toThrow(
		/simulated connect timeout/i,
	);
	await expect(manager.ensureConnected("prod", runner)).rejects.toThrow(
		/simulated connect timeout/i,
	);
	await expect(manager.ensureConnected("prod", runner)).rejects.toThrow(/temporarily blocked/i);
});

async function withEnv<T>(
	env: Record<string, string | undefined>,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function readFakeLog(): Promise<Array<{ kind: string; args: string[] }>> {
	const raw = await readFile(fakeLogPath, "utf8").catch(() => "");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; args: string[] });
}

async function runFakeProcess(bin: string, args: string[], timeoutMs = 10_000) {
	const { spawn } = await import("node:child_process");
	const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
	const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
	try {
		const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
			readBytes(child.stdout),
			readBytes(child.stderr),
			new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => resolve(code));
			}),
		]);
		const stdout = new TextDecoder().decode(stdoutBytes);
		const stderr = new TextDecoder().decode(stderrBytes);
		return {
			exitCode,
			stdout,
			stderr,
			output: `${stdout}${stderr}`,
			truncated: false,
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function readBytes(stream: NodeJS.ReadableStream | null | undefined): Promise<Uint8Array> {
	if (!stream) return new Uint8Array();
	const chunks: Buffer[] = [];
	for await (const chunk of stream as AsyncIterable<Buffer | string>) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function failingFakeSshSource(logPath: string): string {
	return `#!/usr/bin/env bun
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const logFile = ${JSON.stringify(logPath)};

async function log(kind) {
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, JSON.stringify({ kind, args }) + "\\n");
}

const socketIndex = args.indexOf("-S");
const socketPath = socketIndex >= 0 ? args[socketIndex + 1] : undefined;

if (args.includes("-O") && args.includes("check")) {
  await log("check");
  console.error("No ControlMaster");
  process.exit(255);
}

if (args.includes("-M") && args.includes("-N") && args.includes("-f")) {
  await log("start");
  if (socketPath) {
    await mkdir(dirname(socketPath), { recursive: true });
  }
  console.error("simulated connect timeout");
  process.exit(255);
}

await log("run");
process.stdout.write("ok\\n");
process.exit(0);
`;
}

function fakeSshSource(logPath: string): string {
	return `#!/usr/bin/env bun
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};

function argAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function log(kind) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify({ kind, args }) + "\\n");
}

const socketPath = argAfter("-S");
const controlPathArg = args.find((arg) => typeof arg === "string" && arg.startsWith("ControlPath="));
const sshfsSocketPath = controlPathArg ? controlPathArg.slice("ControlPath=".length) : undefined;
const effectiveSocketPath = socketPath ?? sshfsSocketPath;
const mountTarget = args.at(-2);
const mountPath = args.at(-1);

if (args.includes("-O") && args.includes("check")) {
  await log("check");
  if (effectiveSocketPath && await Bun.file(effectiveSocketPath).exists()) process.exit(0);
  console.error("No ControlMaster");
  process.exit(255);
}

if (args.includes("-M") && args.includes("-N") && args.includes("-f")) {
  await log("start");
  if (!effectiveSocketPath) process.exit(2);
  await mkdir(dirname(effectiveSocketPath), { recursive: true });
  await Bun.write(effectiveSocketPath, "master");
  process.exit(0);
}

if (typeof mountTarget === "string" && mountTarget.endsWith(":/") && typeof mountPath === "string") {
  await log("mount");
  await mkdir(mountPath, { recursive: true });
  await Bun.write(mountPath + "/.mounted", "yes");
  process.exit(0);
}

const cmd = args.at(-1);
await log("run");
if (cmd === "say-hello") {
  process.stdout.write("hello\\n");
  process.stderr.write("warn\\n");
  process.exit(0);
}
if (cmd === "slow-output") {
  process.stdout.write("before timeout\\n");
  process.stderr.write("err " + (effectiveSocketPath ?? "") + "\\n");
  await Bun.sleep(2000);
  process.exit(0);
}
process.stdout.write("ok\\n");
process.exit(0);
`;
}
