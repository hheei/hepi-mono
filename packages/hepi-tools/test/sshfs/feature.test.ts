import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createSshfsFeature,
	type SshfsToolDetails,
	validateSshfsHost,
} from "../../src/pi-sshfs/index.js";

interface RegisteredSshfsTool {
	readonly name: string;
	readonly executionMode?: "sequential" | "parallel";
	readonly promptGuidelines?: readonly string[];
	execute(
		toolCallId: string,
		params: { readonly host: string },
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<SshfsToolDetails>>;
}

interface ExecCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly options?: {
		readonly signal?: AbortSignal;
		readonly timeout?: number;
	};
}

interface MountedState {
	readonly source: string;
	readonly path: string;
	readonly type: string;
}

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

function harness(): {
	readonly pi: ExtensionAPI;
	readonly calls: ExecCall[];
	readonly tool: () => RegisteredSshfsTool;
	readonly mounted: () => MountedState | undefined;
	setMounted(state: MountedState | undefined): void;
	setSshfsKilled(value: boolean): void;
	setUnmountKilled(value: boolean): void;
	setUnmountFails(value: boolean): void;
	setUnmountLeavesMounted(value: boolean): void;
	setFilesystemSource(value: string | undefined): void;
	setMountVisibilityDelay(value: number): void;
	abortSshfsWith(controller: AbortController | undefined): void;
} {
	const calls: ExecCall[] = [];
	let registered: RegisteredSshfsTool | undefined;
	let mounted: MountedState | undefined;
	let sshfsKilled = false;
	let unmountKilled = false;
	let unmountFails = false;
	let unmountLeavesMounted = false;
	let filesystemSource: string | undefined;
	let mountVisibilityDelay = 0;
	let abortController: AbortController | undefined;
	const pi = {
		registerTool(tool: RegisteredSshfsTool) {
			registered = tool;
		},
		async exec(
			command: string,
			args: string[],
			options?: { readonly signal?: AbortSignal; readonly timeout?: number },
		) {
			calls.push(options ? { command, args, options } : { command, args });
			if (command === "mount") {
				const visible = mounted !== undefined && mountVisibilityDelay === 0;
				if (mounted !== undefined && mountVisibilityDelay > 0) mountVisibilityDelay -= 1;
				return {
					stdout:
						visible && mounted
							? `${mounted.source} on ${mounted.path} type ${mounted.type} (rw)\n`
							: "",
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			if (command === "df") {
				const source = filesystemSource ?? mounted?.source ?? "/dev/local";
				const path = args.at(-1) ?? "/fixture";
				return {
					stdout: `Filesystem 512-blocks Used Available Capacity Mounted on\n${source} 1 1 1 1% ${path}\n`,
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			if (command === "sshfs") {
				const source = args.at(-2);
				const path = args.at(-1);
				if (source === undefined || path === undefined)
					throw new Error("invalid sshfs fixture args");
				mounted = { source, path, type: "fuse.sshfs" };
				filesystemSource = undefined;
				abortController?.abort();
				return { stdout: "", stderr: "", code: 0, killed: sshfsKilled };
			}
			if (command === "fusermount" || command === "umount" || command === "diskutil") {
				if (!unmountFails && !unmountKilled && !unmountLeavesMounted) mounted = undefined;
				return {
					stdout: "",
					stderr: unmountFails ? "busy" : "",
					code: unmountFails ? 1 : 0,
					killed: unmountKilled,
				};
			}
			return { stdout: "", stderr: "unsupported", code: 1, killed: false };
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		calls,
		tool: () => {
			if (!registered) throw new Error("sshfs tool was not registered");
			return registered;
		},
		mounted: () => mounted,
		setMounted: (state) => {
			mounted = state;
		},
		setSshfsKilled: (value) => {
			sshfsKilled = value;
		},
		setUnmountKilled: (value) => {
			unmountKilled = value;
		},
		setUnmountFails: (value) => {
			unmountFails = value;
		},
		setUnmountLeavesMounted: (value) => {
			unmountLeavesMounted = value;
		},
		setFilesystemSource: (value) => {
			filesystemSource = value;
		},
		setMountVisibilityDelay: (value) => {
			mountVisibilityDelay = value;
		},
		abortSshfsWith: (controller) => {
			abortController = controller;
		},
	};
}

async function temporaryMountRoot(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-basics-sshfs-"));
	temporaryPaths.push(path);
	return path;
}

function textOf(result: AgentToolResult<SshfsToolDetails>): string {
	return result.content
		.filter(
			(item): item is { readonly type: "text"; readonly text: string } => item.type === "text",
		)
		.map((item) => item.text)
		.join("\n");
}

describe("sshfs feature", () => {
	test("mounts the remote root, returns its local path, and reuses it", async () => {
		const mountRoot = await temporaryMountRoot();
		const host = harness();
		const feature = createSshfsFeature(host.pi, { mountRoot, platform: "linux" });
		const tool = host.tool();

		const first = await tool.execute("call-1", { host: "prod" }, undefined);
		const second = await tool.execute("call-2", { host: "prod" }, undefined);

		expect(tool.name).toBe("sshfs");
		expect(tool.executionMode).toBe("sequential");
		expect(host.calls.filter((call) => call.command === "sshfs")).toHaveLength(1);
		const sshfsCall = host.calls.find((call) => call.command === "sshfs");
		expect(sshfsCall?.args).toContain("prod:/");
		expect(sshfsCall?.options?.signal).toBeDefined();
		expect(first.details).toEqual({
			host: "prod",
			localPath: join(mountRoot, "prod"),
			status: "mounted",
		});
		expect(second.details?.status).toBe("reused");
		const output = textOf(first);
		expect(output).toContain(`Home path: ${join(mountRoot, "prod")}`);
		for (const name of ["grep", "edit", "write", "read", "find", "ls"])
			expect(output).toContain(`\`${name}\``);
		expect(tool.promptGuidelines?.join("\n")).toContain("returned local path");

		await feature.dispose();
		expect(host.mounted()).toBeUndefined();
		expect(host.calls.some((call) => call.command === "fusermount")).toBe(true);
	});

	test("refuses a mountpoint occupied by another filesystem", async () => {
		const mountRoot = await temporaryMountRoot();
		const localPath = join(mountRoot, "prod");
		const host = harness();
		host.setMounted({ source: "/dev/disk1", path: localPath, type: "ext4" });
		createSshfsFeature(host.pi, { mountRoot, platform: "linux" });

		await expect(host.tool().execute("call", { host: "prod" }, undefined)).rejects.toThrow(
			"occupied by another filesystem",
		);
		expect(host.calls.some((call) => call.command === "sshfs")).toBe(false);
		expect(host.calls.some((call) => call.command === "fusermount")).toBe(false);
		expect(host.mounted()?.source).toBe("/dev/disk1");
	});

	test("does not unmount a replacement filesystem during cleanup", async () => {
		const mountRoot = await temporaryMountRoot();
		const localPath = join(mountRoot, "prod");
		const host = harness();
		const feature = createSshfsFeature(host.pi, { mountRoot, platform: "linux" });
		await host.tool().execute("call", { host: "prod" }, undefined);
		host.setMounted({ source: "/dev/disk1", path: localPath, type: "ext4" });

		await feature.dispose();
		expect(host.mounted()?.source).toBe("/dev/disk1");
		expect(host.calls.some((call) => call.command === "fusermount")).toBe(false);
	});

	test("ignores stale mount-table entries whose live filesystem source differs", async () => {
		const mountRoot = await temporaryMountRoot();
		const localPath = join(mountRoot, "prod");
		const host = harness();
		host.setMounted({ source: "prod:/", path: localPath, type: "fuse.sshfs" });
		host.setFilesystemSource("/dev/local");
		const feature = createSshfsFeature(host.pi, { mountRoot, platform: "linux" });

		const result = await host.tool().execute("call", { host: "prod" }, undefined);
		expect(result.details?.status).toBe("mounted");
		expect(host.calls.filter((call) => call.command === "sshfs")).toHaveLength(1);
		await feature.dispose();
	});

	test("waits for a daemonized mount to become visible", async () => {
		const mountRoot = await temporaryMountRoot();
		const host = harness();
		host.setMountVisibilityDelay(2);
		const feature = createSshfsFeature(host.pi, { mountRoot, platform: "linux" });

		const result = await host.tool().execute("call", { host: "prod" }, undefined);
		expect(result.details?.status).toBe("mounted");
		expect(host.calls.filter((call) => call.command === "mount").length).toBeGreaterThan(2);
		await feature.dispose();
	});

	test("rolls back an aborted mount and forwards the signal", async () => {
		const mountRoot = await temporaryMountRoot();
		const host = harness();
		const controller = new AbortController();
		host.abortSshfsWith(controller);
		createSshfsFeature(host.pi, { mountRoot, platform: "linux" });

		await expect(
			host.tool().execute("call", { host: "prod" }, controller.signal),
		).rejects.toThrow();
		const operationSignal = host.calls.find((call) => call.command === "sshfs")?.options?.signal;
		expect(operationSignal).not.toBe(controller.signal);
		expect(operationSignal?.aborted).toBe(true);
		expect(host.mounted()).toBeUndefined();
	});

	test("retains ownership when rollback unmount fails and retries on dispose", async () => {
		const mountRoot = await temporaryMountRoot();
		const host = harness();
		host.setSshfsKilled(true);
		host.setUnmountFails(true);
		const feature = createSshfsFeature(host.pi, { mountRoot, platform: "linux" });

		await expect(host.tool().execute("call", { host: "prod" }, undefined)).rejects.toThrow(
			"timed out",
		);
		expect(host.mounted()).toBeDefined();
		await expect(feature.dispose()).rejects.toThrow("Unable to clean up SSHFS mounts");

		host.setUnmountFails(false);
		await feature.dispose();
		expect(host.mounted()).toBeUndefined();
	});

	test("does not accept a killed unmount as successful cleanup", async () => {
		const mountRoot = await temporaryMountRoot();
		const host = harness();
		const feature = createSshfsFeature(host.pi, { mountRoot, platform: "linux" });
		await host.tool().execute("call", { host: "prod" }, undefined);
		host.setUnmountKilled(true);

		await expect(feature.dispose()).rejects.toThrow("Unable to clean up SSHFS mounts");
		expect(host.mounted()).toBeDefined();

		host.setUnmountKilled(false);
		await feature.dispose();
		expect(host.mounted()).toBeUndefined();
	});

	test("verifies that a successful unmount command removed the mount", async () => {
		const mountRoot = await temporaryMountRoot();
		const host = harness();
		const feature = createSshfsFeature(host.pi, { mountRoot, platform: "linux" });
		await host.tool().execute("call", { host: "prod" }, undefined);
		host.setUnmountLeavesMounted(true);

		await expect(feature.dispose()).rejects.toThrow("Unable to clean up SSHFS mounts");
		expect(host.mounted()).toBeDefined();

		host.setUnmountLeavesMounted(false);
		await feature.dispose();
		expect(host.mounted()).toBeUndefined();
	});

	test("rejects symlink mountpoints", async () => {
		const root = await temporaryMountRoot();
		const mountRoot = join(root, "mounts");
		const target = join(root, "target");
		await mkdir(mountRoot);
		await mkdir(target);
		await symlink(target, join(mountRoot, "prod"));
		const host = harness();
		createSshfsFeature(host.pi, { mountRoot, platform: "linux" });

		await expect(host.tool().execute("call", { host: "prod" }, undefined)).rejects.toThrow(
			"real directory",
		);
		expect(host.calls).toHaveLength(0);
	});

	test("uses a traversal-safe directory for OpenSSH destinations", async () => {
		const mountRoot = await temporaryMountRoot();
		const host = harness();
		const feature = createSshfsFeature(host.pi, { mountRoot, platform: "darwin" });
		const result = await host.tool().execute("call", { host: "user@host:2200" }, undefined);

		expect(result.details?.localPath).toBe(join(mountRoot, "user%40host%3A2200"));
		const sshfsArgs = host.calls.find((call) => call.command === "sshfs")?.args;
		expect(sshfsArgs).toContain("local");
		await feature.dispose();
		expect(host.calls.some((call) => call.command === "umount")).toBe(true);
	});

	test("rejects unsafe hosts and unsupported local platforms", async () => {
		expect(() => validateSshfsHost("-oProxyCommand=sh")).toThrow("must not start");
		expect(() => validateSshfsHost("host name")).toThrow("whitespace");

		const mountRoot = await temporaryMountRoot();
		const host = harness();
		createSshfsFeature(host.pi, { mountRoot, platform: "win32" });
		await expect(host.tool().execute("call", { host: "prod" }, undefined)).rejects.toThrow(
			"Linux and macOS",
		);
	});
});
