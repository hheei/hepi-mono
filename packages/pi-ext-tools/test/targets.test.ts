import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { targetSettingsFromState } from "../src/fff/settings.js";
import { createTargetSettingsProvider } from "../src/fff/target-settings.js";
import {
	applyTargetPromptSection,
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
					home: directory,
					sshConfigPath: config,
					notify: (message) => warnings.push(message),
				},
				["dev", "local", "missing"],
			);
			try {
				expect(runtime.prompt()).toContain("dev");
				expect(runtime.prompt()).toContain("bash and apply_patch accept local");
				expect(runtime.prompt()).not.toContain("<pi-ext-tools-targets>");
				expect(warnings).toHaveLength(1);
				expect(() => runtime.validateRemotePath("../secret")).toThrow("..");
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("applies and removes the Pi systemPrompt section without wrapping tags", async () => {
		const directory = await temporaryDirectory();
		try {
			const runtime = await TargetRuntime.create(
				{
					home: directory,
					notify: () => undefined,
				},
				[],
			);
			try {
				const sections: Record<string, string> = { other: "keep" };
				applyTargetPromptSection(sections, runtime);
				expect(sections.other).toBe("keep");
				expect(sections["pi-ext-tools-targets"]).toContain("Authorized SSH targets: none");
				expect(sections["pi-ext-tools-targets"]).not.toContain("<pi-ext-tools-targets>");
				applyTargetPromptSection(sections, undefined);
				expect(sections.other).toBe("keep");
				expect(sections["pi-ext-tools-targets"]).toBeUndefined();
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

	test("creates ControlPath before the POSIX probe and does not cache SSH failures", async () => {
		const directory = await temporaryDirectory();
		const bin = join(directory, "bin");
		const state = join(directory, "state");
		await mkdir(bin);
		await mkdir(state);
		const ssh = join(bin, "ssh");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell ${arg#prefix} parameter expansion
		const assignControl = " control=${arg#ControlPath=}";
		await writeFile(
			ssh,
			[
				"#!/bin/sh",
				'control=""',
				'prev=""',
				'for arg in "$@"; do',
				'  if [ "$prev" = "-o" ]; then',
				'    case "$arg" in',
				`      ControlPath=*)${assignControl} ;;`,
				"    esac",
				"  fi",
				'  prev="$arg"',
				"done",
				`echo "$control" >> "${state}/control"`,
				'if [ -n "$control" ] && [ ! -d "$(dirname "$control")" ]; then',
				'  echo "unix_listener: cannot bind to path $control: No such file or directory" >&2',
				"  exit 255",
				"fi",
				`if [ ! -f "${state}/once" ]; then`,
				`  touch "${state}/once"`,
				'  echo "Connection refused" >&2',
				"  exit 255",
				"fi",
				"echo Linux",
				"exit 0",
				"",
			].join("\n"),
			"utf8",
		);
		await chmod(ssh, 0o755);
		await writeFile(join(directory, "ssh-config"), "Host ileqm\n  HostName example.test\n", "utf8");
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		const sessionId = "01a018bf-3468-7ca4-8e67-f3bcdf3e119e";
		const expected = join(
			directory,
			".pi",
			"agent",
			"extensions",
			"pi-ext-tools",
			"targets",
			"ileqm.sock",
		);
		try {
			const runtime = await TargetRuntime.create(
				{
					home: directory,
					sshConfigPath: join(directory, "ssh-config"),
					sessionManager: { getSessionId: () => sessionId },
				},
				["ileqm"],
			);
			try {
				await expect(runtime.grep("ileqm", "rg --json foo")).rejects.toThrow("Connection refused");
				await expect(runtime.grep("ileqm", "rg --json foo")).resolves.toBe("Linux\n");
			} finally {
				await runtime.close();
			}
			const recorded = (await readFile(join(state, "control"), "utf8")).trim().split("\n");
			expect(recorded.every((path) => path === expected)).toBe(true);
			expect(recorded.some((path) => path.includes(sessionId))).toBe(false);
		} finally {
			process.env.PATH = previousPath;
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("exec runs remote commands from home without a default timeout", async () => {
		const directory = await temporaryDirectory();
		const bin = join(directory, "bin");
		await mkdir(bin);
		await writeFile(
			join(bin, "ssh"),
			[
				"#!/bin/sh",
				'last=""',
				'for arg in "$@"; do last=$arg; done',
				'if [ "$last" = "uname -s" ]; then echo Linux; exit 0; fi',
				'printf "%s\n" "$last"',
				'eval "$last"',
				"",
			].join("\n"),
			"utf8",
		);
		await chmod(join(bin, "ssh"), 0o755);
		await writeFile(join(directory, "ssh-config"), "Host ileqm\n  HostName example.test\n", "utf8");
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		try {
			const runtime = await TargetRuntime.create(
				{
					home: directory,
					sshConfigPath: join(directory, "ssh-config"),
				},
				["ileqm"],
			);
			try {
				const chunks: Buffer[] = [];
				const result = await runtime.exec("ileqm", "printf ran; exit 7", {
					onData: (chunk) => chunks.push(chunk),
				});
				expect(result).toEqual({ code: 7, timedOut: false });
				const output = Buffer.concat(chunks).toString("utf8");
				expect(output).toContain('cd "$HOME" && printf ran; exit 7');
				expect(output).toContain("ran");
				await expect(runtime.exec("nope", "true")).rejects.toThrow("unauthorized");
			} finally {
				await runtime.close();
			}
		} finally {
			process.env.PATH = previousPath;
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("exec timeout returns timedOut instead of throwing", async () => {
		const directory = await temporaryDirectory();
		const bin = join(directory, "bin");
		await mkdir(bin);
		await writeFile(
			join(bin, "ssh"),
			[
				"#!/bin/sh",
				'last=""',
				'for arg in "$@"; do last=$arg; done',
				'if [ "$last" = "uname -s" ]; then echo Linux; exit 0; fi',
				"exec sleep 30",
				"",
			].join("\n"),
			"utf8",
		);
		await chmod(join(bin, "ssh"), 0o755);
		await writeFile(join(directory, "ssh-config"), "Host ileqm\n  HostName example.test\n", "utf8");
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		try {
			const runtime = await TargetRuntime.create(
				{
					home: directory,
					sshConfigPath: join(directory, "ssh-config"),
				},
				["ileqm"],
			);
			try {
				const result = await runtime.exec("ileqm", "sleep 30", { timeoutMs: 150 });
				expect(result.timedOut).toBe(true);
			} finally {
				await runtime.close();
			}
		} finally {
			process.env.PATH = previousPath;
			await rm(directory, { recursive: true, force: true });
		}
	});
});
