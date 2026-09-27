import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";
import { describe, expect, test } from "vitest";
import { FFF_RUNTIME_NOT_READY_TEXT } from "../../src/fff/extension-common.js";
import type { FffRuntime } from "../../src/fff/fff.js";
import { registerCommands } from "../../src/fff/register-commands.js";

type NotifyCall = [message: string, level: string | undefined];

function setup(runtime: FffRuntime | null) {
	const registered: {
		name: string;
		description: string | undefined;
		handler: (args: string, ctx: unknown) => Promise<void>;
		getArgumentCompletions?:
			| ((prefix: string) => { value: string; label: string }[] | null)
			| undefined;
	}[] = [];
	registerCommands(
		{
			registerCommand(
				name: string,
				command: {
					handler: never;
					description?: string | undefined;
					getArgumentCompletions?:
						| ((prefix: string) => { value: string; label: string }[] | null)
						| undefined;
				},
			) {
				registered.push({
					name,
					description: command.description,
					handler: command.handler,
					getArgumentCompletions: command.getArgumentCompletions,
				});
			},
		} as unknown as ExtensionAPI,
		{ getRuntime: () => runtime },
	);
	const command = registered[0];
	if (!command) throw new Error("no command registered");

	const notifyCalls: NotifyCall[] = [];
	const ctx = {
		ui: {
			notify: (message: string, level?: string) => {
				notifyCalls.push([message, level]);
			},
		},
	};
	return {
		name: command.name,
		description: command.description,
		completions: command.getArgumentCompletions,
		run: async (args: string) => {
			await command.handler(args, ctx);
			return notifyCalls.at(-1);
		},
	};
}

const metadata = {
	cwd: "/tmp/project",
	projectRoot: "/tmp/project",
	dbDir: "/tmp/project/.fff",
	frecencyDbPath: "/tmp/project/.fff/frecency.db",
	historyDbPath: "/tmp/project/.fff/history.db",
	definitionClassification: "heuristic",
} as const;

function fakeRuntime(overrides: Partial<Record<string, unknown>> = {}): FffRuntime {
	return {
		reindex: async () => Result.ok(),
		getStatus: async () => Result.ok({ state: "ready", indexedFiles: 7 }),
		getMetadata: async () => metadata,
		healthCheck: async () =>
			Result.ok({
				version: "0.10.6",
				git: { available: true, repositoryFound: true, libgit2Version: "1.8" },
				filePicker: { initialized: true, basePath: "/tmp/project", indexedFiles: 7 },
				frecency: { initialized: true },
				queryTracker: { initialized: false },
			}),
		...overrides,
	} as unknown as FffRuntime;
}

describe("FFF command", () => {
	test("registers one command surface instead of one command per action", () => {
		const command = setup(fakeRuntime());
		expect(command.name).toBe("fff");
		expect(command.description).toContain("status");
		expect(command.description).toContain("reindex");
	});

	test("runs a reindex for /fff reindex", async () => {
		let reindexed = 0;
		const command = setup(
			fakeRuntime({
				reindex: async () => {
					reindexed += 1;
					return Result.ok();
				},
			}),
		);

		const call = await command.run("reindex");

		expect(reindexed).toBe(1);
		expect(call?.[0]).toBe("FFF reindex started");
	});

	test("reports the runtime status for /fff status", async () => {
		const call = await setup(fakeRuntime()).run("status");

		expect(call?.[1]).toBe("info");
		expect(call?.[0]).toContain("state: ready");
		expect(call?.[0]).toContain("indexed files: 7");
		expect(call?.[0]).toContain("project root: /tmp/project");
	});

	test("accepts surrounding whitespace and mixed case", async () => {
		const call = await setup(fakeRuntime()).run("  Reindex  ");
		expect(call?.[0]).toBe("FFF reindex started");
	});

	test("rejects an unknown subcommand with the usage line", async () => {
		const call = await setup(fakeRuntime()).run("maybe");
		expect(call?.[0]).toBe('Unknown subcommand "maybe". Usage: /fff status|reindex');
	});

	test("refuses an empty invocation instead of guessing", async () => {
		const call = await setup(fakeRuntime()).run("");
		expect(call?.[0]).toBe('Unknown subcommand "". Usage: /fff status|reindex');
	});

	test("reports an unavailable runtime before the subcommand runs", async () => {
		const call = await setup(null).run("reindex");

		expect(call?.[0]).toBe(FFF_RUNTIME_NOT_READY_TEXT);
		expect(call?.[1]).toBe("warning");
	});

	test("completes its subcommands", () => {
		const { completions } = setup(null);
		expect(completions?.("")).toEqual([
			{ value: "status", label: "status" },
			{ value: "reindex", label: "reindex" },
		]);
		expect(completions?.("re")).toEqual([{ value: "reindex", label: "reindex" }]);
		expect(completions?.("nope")).toBeNull();
	});
});
