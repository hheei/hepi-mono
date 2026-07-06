import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/scripts/session-manager.js";
import type { SshExecArgs, SshExecResult } from "../src/scripts/ssh-exec.js";
import { createMcpServer, runCleanupSshProcess } from "../src/scripts/ssh-exec-mcp.js";
import type { SshMountArgs } from "../src/scripts/ssh-mount.js";

test("MCP initialize tools/list expose ssh_exec, ssh_mount, and ssh_host", async () => {
	const server = createMcpServer({ execute: successfulExecute });

	const initialize = await server.handle({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		},
	});
	const tools = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });

	expect(initialize).toMatchObject({
		jsonrpc: "2.0",
		id: 1,
		result: {
			protocolVersion: "2025-06-18",
			serverInfo: { name: "ssh", version: "0.5.0" },
		},
	});
	expect(
		(tools as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name),
	).toEqual(["ssh_exec", "ssh_mount", "ssh_host"]);
});

test("tools/call rejects unsafe ssh_exec and ssh_mount hosts before execution", async () => {
	let execCalls = 0;
	let mountCalls = 0;

	const server = createMcpServer({
		execute: async (args: SshExecArgs) => {
			execCalls += 1;
			return await successfulExecute(args);
		},
		mount: async (args: SshMountArgs) => {
			mountCalls += 1;
			return { host: args.host, localPath: "/tmp/ssh-mount/prod", status: "mounted" };
		},
	});

	const execResponse = await server.handle({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "ssh_exec", arguments: { host: "-oProxyCommand=sh", command: "echo x" } },
	});
	const mountResponse = await server.handle({
		jsonrpc: "2.0",
		id: 4,
		method: "tools/call",
		params: { name: "ssh_mount", arguments: { host: "-bad" } },
	});

	expect(execCalls).toBe(0);
	expect(mountCalls).toBe(0);
	expect(execResponse).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32602 } });
	expect(mountResponse).toMatchObject({ jsonrpc: "2.0", id: 4, error: { code: -32602 } });
});

test("tools/call returns ssh_host matches", async () => {
	const server = createMcpServer({
		findHosts: async (pattern: string) => {
			const hosts = [
				{
					alias: "ileqm",
					user: "chlo",
					hostname: "100.80.181.114",
					display: "ileqm (chlo@100.80.181.114)",
				},
				{
					alias: "sccpu",
					user: "hheei",
					hostname: "xh5.hpccube.com",
					display: "sccpu (hheei@xh5.hpccube.com)",
				},
			];
			if (pattern === "*") return hosts;
			const matcher = new RegExp(pattern);
			return hosts.filter((host) => matcher.test(host.alias));
		},
	});

	const response = await server.handle({
		jsonrpc: "2.0",
		id: 5,
		method: "tools/call",
		params: { name: "ssh_host", arguments: { ssh_host: "ileqm|sccpu" } },
	});

	expect(response).toMatchObject({
		jsonrpc: "2.0",
		id: 5,
		result: {
			content: [
				{ type: "text", text: "ileqm (chlo@100.80.181.114)\nsccpu (hheei@xh5.hpccube.com)" },
			],
		},
	});
});

test("tools/call returns no-host text when ssh_host is missing", async () => {
	const server = createMcpServer({
		findHosts: async () => [],
	});

	const response = await server.handle({
		jsonrpc: "2.0",
		id: 6,
		method: "tools/call",
		params: { name: "ssh_host", arguments: { ssh_host: "ileqm" } },
	});

	expect(response).toMatchObject({
		jsonrpc: "2.0",
		id: 6,
		result: {
			content: [{ type: "text", text: "No `ileqm` host." }],
			structuredContent: { hosts: [] },
		},
	});
});

test("tools/call returns compact ssh_mount success text", async () => {
	const server = createMcpServer({
		mount: async (args: SshMountArgs) => ({
			host: args.host,
			localPath: "/tmp/ssh-mount/prod",
			status: "remounted",
		}),
	});

	const response = await server.handle({
		jsonrpc: "2.0",
		id: 7,
		method: "tools/call",
		params: { name: "ssh_mount", arguments: { host: "prod" } },
	});

	const result = (
		response as {
			result: {
				content: Array<{ text: string }>;
				structuredContent: Record<string, unknown>;
			};
		}
	).result;

	expect(result.content[0]?.text).toContain("Success.");
	expect(result.content[0]?.text).toContain("Local path: /tmp/ssh-mount/prod/");
	expect(result.content[0]?.text).toContain("Home path: /tmp/ssh-mount/prod/...");
	expect(result.structuredContent).toEqual({
		host: "prod",
		localPath: "/tmp/ssh-mount/prod",
		status: "remounted",
	});
});

test("default MCP executor keeps timeout tail output for ssh_exec", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "ssh-exec-mcp-timeout-test-"));
	const fakeSsh = join(tmpRoot, "fake-timeout-ssh.ts");

	await writeFile(
		fakeSsh,
		`#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const socketPath = args[args.indexOf("-S") + 1];
if (args.includes("-O") && args.includes("check")) process.exit(255);
if (args.includes("-M") && args.includes("-N") && args.includes("-f")) {
  await mkdir(dirname(socketPath), { recursive: true });
  await Bun.write(socketPath, "master");
  process.exit(0);
}
process.stdout.write("partial before timeout\\n");
await Bun.sleep(2000);
process.exit(0);
`,
	);
	await chmod(fakeSsh, 0o755);

	try {
		const server = createMcpServer({
			manager: new SessionManager({ sshBin: fakeSsh, controlDir: join(tmpRoot, "control") }),
		});

		const response = await server.handle({
			jsonrpc: "2.0",
			id: 8,
			method: "tools/call",
			params: { name: "ssh_exec", arguments: { host: "prod", command: "slow", timeout: 2 } },
		});
		const text =
			(response as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? "";

		expect(text).toContain("partial before timeout");
		expect(text).toContain("timed out");
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("cleanup runner captures stdout and stderr", async () => {
	const tmpRoot = await mkdtemp(join(tmpdir(), "ssh-exec-cleanup-test-"));
	const fakeSsh = join(tmpRoot, "fake-cleanup-ssh.ts");

	await writeFile(
		fakeSsh,
		`#!/usr/bin/env bun
process.stdout.write("out\\n");
process.stderr.write("err\\n");
process.exit(0);
`,
	);
	await chmod(fakeSsh, 0o755);

	try {
		const result = await runCleanupSshProcess(fakeSsh, []);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("out");
		expect(result.stderr).toContain("err");
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("tools/call returns ssh_mount errors without fake mounted payload", async () => {
	const server = createMcpServer({
		mount: async () => {
			throw new Error("mount failed");
		},
	});

	const response = await server.handle({
		jsonrpc: "2.0",
		id: 9,
		method: "tools/call",
		params: { name: "ssh_mount", arguments: { host: "prod" } },
	});

	expect(response).toMatchObject({
		jsonrpc: "2.0",
		id: 9,
		result: {
			isError: true,
			content: [{ type: "text", text: "mount failed" }],
		},
	});
});
test("MCP disabled hosts from environment filter lookup and block calls", async () => {
	let execCalls = 0;
	let mountCalls = 0;

	await withEnv({ SSH_EXEC_DISABLED_HOSTS: JSON.stringify(["prod", "staging"]) }, async () => {
		const server = createMcpServer({
			findHosts: async () => [
				{ alias: "prod", hostname: "prod.example.com", display: "prod (prod.example.com)" },
				{ alias: "dev", hostname: "dev.example.com", display: "dev (dev.example.com)" },
			],
			execute: async (args: SshExecArgs) => {
				execCalls += 1;
				return await successfulExecute(args);
			},
			mount: async (args: SshMountArgs) => {
				mountCalls += 1;
				return { host: args.host, localPath: "/tmp/ssh-mount/prod", status: "mounted" };
			},
		});

		const hostResponse = await server.handle({
			jsonrpc: "2.0",
			id: 10,
			method: "tools/call",
			params: { name: "ssh_host", arguments: { ssh_host: "*" } },
		});
		const execResponse = await server.handle({
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "ssh_exec", arguments: { host: "prod", command: "echo hi" } },
		});
		const mountResponse = await server.handle({
			jsonrpc: "2.0",
			id: 12,
			method: "tools/call",
			params: { name: "ssh_mount", arguments: { host: "prod" } },
		});

		expect(
			(hostResponse as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
		).toBe("dev (dev.example.com)");
		expect(execResponse).toMatchObject({ result: { isError: true } });
		expect(mountResponse).toMatchObject({ result: { isError: true } });
	});

	expect(execCalls).toBe(0);
	expect(mountCalls).toBe(0);
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

function successfulExecute(args: SshExecArgs): Promise<SshExecResult> {
	return Promise.resolve({
		host: args.host,
		exitCode: 0,
		stdout: "hello\n",
		stderr: "warn\n",
		output: "hello\nwarn\n",
		durationMs: 12,
		truncated: false,
		totalBytes: 11,
		outputBytes: 11,
		totalLines: 2,
		outputLines: 2,
	});
}
