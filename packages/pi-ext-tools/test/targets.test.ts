import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutputRegistry } from "@hheei/pi-ext-core";
import { targetSettingsFromState } from "../src/fff/settings.js";
import { createTargetSettingsProvider } from "../src/fff/target-settings.js";
import {
	isPosixUname,
	isTargetError,
	rejectUnsupportedTarget,
	TargetRuntime,
} from "../src/targets.js";

async function temporaryDirectory(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "hepi-targets-"));
}

describe("pi-ext-tools target runtime", () => {
	test("validates the SSH whitelist as a JSON string list", () => {
		const field = createTargetSettingsProvider().groups[0]?.fields[0];
		if (field === undefined) throw new Error("Missing SSH whitelist setting");
		expect(field.type).toBe("list");
		expect(field.parse('["dev", "prod"]')).toEqual(["dev", "prod"]);
		expect(() => field.parse("dev prod")).toThrow("JSON string array");
		expect(field.validate?.(["dev", "dev"])).toContain("unique");
		expect(field.validate?.(Array.from({ length: 33 }, (_, index) => `host-${index}`))).toContain(
			"32",
		);
	});

	test("authorizes only literal SSH aliases and warns about reserved conflicts", async () => {
		const directory = await temporaryDirectory();
		try {
			const config = join(directory, "ssh-config");
			await writeFile(
				config,
				"Host dev\n  HostName example.test\nHost local\n  HostName conflict.test\n",
				"utf8",
			);
			const warnings: string[] = [];
			const runtime = await TargetRuntime.create(
				{
					outputs: createOutputRegistry(),
					home: directory,
					sshConfigPath: config,
					notify: (message) => warnings.push(message),
				},
				["dev", "local", "missing"],
			);
			try {
				expect(runtime.prompt()).toContain("dev");
				expect(runtime.prompt()).not.toContain("missing");
				expect(warnings).toHaveLength(1);
				expect(() => runtime.validateRemotePath("../secret")).toThrow("..");
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("reads output targets and reloads persisted session outputs", async () => {
		const directory = await temporaryDirectory();
		const session = join(directory, "session.jsonl");
		try {
			await writeFile(session, "{}\n", "utf8");
			const options = {
				outputs: createOutputRegistry(),
				home: directory,
				sessionManager: {
					getSessionId: () => "session-id",
					getSessionFile: () => session,
				},
			};
			const runtime = await TargetRuntime.create(options, []);
			const output = runtime.createOutput("first\nsecond");
			expect(output.persistent).toBe(true);
			expect((await runtime.read("output", output.id)).toString("utf8")).toBe("first\nsecond");
			await new Promise((resolve) => setTimeout(resolve, 25));
			await runtime.close();

			const sidecar = `${session}.pi-ext-tools-output.jsonl`;
			expect((await readFile(sidecar, "utf8")).trim()).toContain(output.id);
			const reloaded = await TargetRuntime.create(options, []);
			try {
				expect(reloaded.readOutput(output.id)).toBe("first\nsecond");
			} finally {
				await reloaded.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("warns once when an output exceeds the persistence cap", async () => {
		const directory = await temporaryDirectory();
		const session = join(directory, "session.jsonl");
		try {
			await writeFile(session, "{}\n", "utf8");
			const warnings: string[] = [];
			const runtime = await TargetRuntime.create(
				{
					outputs: createOutputRegistry(),
					home: directory,
					sessionManager: {
						getSessionId: () => "session-id",
						getSessionFile: () => session,
					},
					notify: (message) => warnings.push(message),
				},
				[],
			);
			try {
				const first = runtime.createOutput(`${"x".repeat(1024 * 1024 + 1)}`);
				const second = runtime.createOutput(`${"y".repeat(1024 * 1024 + 1)}`);
				expect(first.persistent).toBe(false);
				expect(second.persistent).toBe(false);
				expect(warnings).toHaveLength(1);
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects invalid SSH whitelist values at load", () => {
		expect(() =>
			targetSettingsFromState({
				targets: { sshWhitelist: ["dev", "dev"] },
			}),
		).toThrow("unique");
	});

	test("classifies POSIX uname values and rejects unsupported mutator targets", () => {
		expect(isPosixUname("Linux")).toBe(true);
		expect(isPosixUname("Darwin")).toBe(true);
		expect(isPosixUname("MINGW64_NT-10.0")).toBe(false);
		expect(() => rejectUnsupportedTarget("edit", { path: "a.ts" })).not.toThrow();
		expect(() => rejectUnsupportedTarget("edit", { path: "a.ts", target: "local" })).not.toThrow();
		try {
			rejectUnsupportedTarget("edit", { path: "a.ts", target: "devbox" });
			throw new Error("expected rejectUnsupportedTarget to throw");
		} catch (error) {
			expect(isTargetError(error)).toBe(true);
			if (isTargetError(error)) expect(error.outcome).toBe("unauthorized");
		}
	});

	test("follows parentSession ancestry and removes stale control sockets", async () => {
		const directory = await temporaryDirectory();
		try {
			const parent = join(directory, "parent.jsonl");
			const child = join(directory, "child.jsonl");
			const outputId = "parent-output";
			await writeFile(parent, "{\n", "utf8");
			await writeFile(
				`${parent}.pi-ext-tools-output.jsonl`,
				`${JSON.stringify({ id: outputId, text: "from-parent" })}\n`,
				"utf8",
			);
			await writeFile(child, `${JSON.stringify({ parentSession: parent })}\n`, "utf8");
			const staleDir = join(directory, ".pi", "agent", "extensions", "pi-ext-tools");
			const stale = join(staleDir, "dead.sock");
			await mkdir(staleDir, { recursive: true });
			await writeFile(stale, "", "utf8");
			const runtime = await TargetRuntime.create(
				{
					outputs: createOutputRegistry(),
					home: directory,
					sessionManager: {
						getSessionId: () => "child",
						getSessionFile: () => child,
					},
				},
				[],
			);
			try {
				expect(runtime.readOutput(outputId)).toBe("from-parent");
				await expect(readFile(stale, "utf8")).rejects.toThrow();
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
