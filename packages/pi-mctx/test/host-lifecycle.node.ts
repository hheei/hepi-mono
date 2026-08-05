import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
} from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { defaultMctxSettingsPaths, loadMctxConfiguration } from "../dist/config.js";

const EXTENSION_PATH = fileURLToPath(new URL("../dist/extension.js", import.meta.url));
const HANDOFF_EXTENSION_PATH = fileURLToPath(
	new URL("../../pi-handoff/dist/extension.js", import.meta.url),
);
const LARGE_PROMPT = "source ".repeat(30_000);
// Pi host documents this environment boundary but does not export its constant.
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

interface HostFixture {
	readonly agentDir: string;
	readonly cwd: string;
	readonly contexts: Context[];
	readonly extensionErrors: string[];
	readonly manager: SessionManager;
	readonly replacement: () => SessionManager | undefined;
	readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	readonly warnings: string[];
	dispose(): Promise<void>;
}

function historianOutput(context: Context): string {
	const text = context.messages
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: Array.isArray(message.content)
					? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: [],
		)
		.reverse()
		.find((part: string) => part.includes("Source entry IDs, in order:"));
	const match = /Source entry IDs, in order: (\[[^\n]+\])/.exec(text ?? "");
	if (match?.[1] === undefined)
		throw new Error("Historian prompt did not include source entry IDs");
	const parsed: unknown = JSON.parse(match[1]);
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		!parsed.every((value) => typeof value === "string")
	) {
		throw new Error("Historian source entry IDs are invalid");
	}
	const first = parsed[0];
	const last = parsed.at(-1);
	if (first === undefined || last === undefined)
		throw new Error("Historian source is unexpectedly empty");
	const tier = /Required tier: (m0|m1)/.exec(text ?? "")?.[1] === "m1" ? "m1" : "m0";
	const output = JSON.stringify({
		tier,
		sourceStartEntryId: first,
		sourceEndEntryId: last,
		renderedPayload: "HOST_MCTX_SUMMARY",
	});
	return output;
}

function isHistorianContext(context: Context): boolean {
	return (
		context.systemPrompt?.includes("You compress one bounded source range") === true ||
		JSON.stringify(context.messages).includes("Source entry IDs, in order:")
	);
}

async function createHost(
	options: {
		readonly agentDir?: string;
		readonly cwd?: string;
		readonly manager?: SessionManager;
		readonly invalidHistorian?: boolean;
		readonly includeHandoff?: boolean;
		readonly runtimeEnabled?: boolean;
		readonly smartDrops?: boolean;
		readonly protectedTags?: number;
		readonly executeThresholdTokens?: number;
	} = {},
): Promise<HostFixture> {
	const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-mctx-host-agent-"));
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-mctx-host-project-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			"pi-mctx": {
				enabled: options.runtimeEnabled ?? true,
				smart_drops: options.smartDrops ?? false,
				protected_tags: options.protectedTags ?? 20,
				historian: { enabled: true, model: "faux/faux-1" },
				execute_threshold_percentage: 20,
				execute_threshold_tokens: { default: options.executeThresholdTokens ?? 5_000 },
			},
		}),
	);
	const previousAgentDir = process.env[PI_AGENT_DIR_ENV];
	process.env[PI_AGENT_DIR_ENV] = agentDir;
	const configuration = await loadMctxConfiguration(defaultMctxSettingsPaths(cwd, agentDir));
	if ((options.runtimeEnabled ?? true) && configuration.pipeline.kind !== "enabled") {
		throw new Error(`Fixture MCTX config did not activate: ${JSON.stringify(configuration)}`);
	}
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000 }],
	});
	const model = faux.getModel();
	const contexts: Context[] = [];
	const steps: FauxResponseStep[] = Array.from({ length: 32 }, () => async (context) => {
		contexts.push(context);
		return fauxAssistantMessage([
			fauxText(
				isHistorianContext(context)
					? options.invalidHistorian
						? "invalid historian output"
						: historianOutput(context)
					: "HOST_PARENT_RESPONSE",
			),
		]);
	});
	faux.setResponses(steps);
	const modelRuntime = {
		getModel: (provider: string, id: string) =>
			provider === model.provider && id === model.id ? model : undefined,
		getModels: () => [model],
		getAvailableSnapshot: () => [model],
		hasConfiguredAuth: (): boolean => true,
		checkAuth: async () => undefined,
		isUsingOAuth: (): boolean => false,
		getAuth: async () => undefined,
		getCompatibilityRequestConfig: () => ({}),
		streamSimple,
	} as unknown as ModelRuntime;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [
			EXTENSION_PATH,
			...(options.includeHandoff ? [HANDOFF_EXTENSION_PATH] : []),
		],
		systemPromptOverride: () => "Host verification fixture.",
		appendSystemPromptOverride: () => [],
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const manager = options.manager ?? SessionManager.create(cwd, join(agentDir, "sessions"));
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});
	const warnings: string[] = [];
	const extensionErrors: string[] = [];
	let replacement: SessionManager | undefined;
	session.extensionRunner?.onError((error) => {
		extensionErrors.push(error.error);
	});
	await session.bindExtensions({
		uiContext: {
			notify: (message: string): void => {
				warnings.push(message);
			},
		} as never,
		commandContextActions: {
			waitForIdle: async (): Promise<void> => undefined,
			newSession: async (options): Promise<{ cancelled: boolean }> => {
				const next = SessionManager.create(cwd, manager.getSessionDir());
				if (options?.parentSession !== undefined)
					next.newSession({ parentSession: options.parentSession });
				await options?.setup?.(next);
				replacement = next;
				return { cancelled: false };
			},
			fork: async (): Promise<{ cancelled: boolean }> => ({ cancelled: true }),
			navigateTree: async (): Promise<{ cancelled: boolean }> => ({ cancelled: true }),
			switchSession: async (): Promise<{ cancelled: boolean }> => ({ cancelled: true }),
			reload: async (): Promise<void> => undefined,
		},
	});
	return {
		agentDir,
		cwd,
		contexts,
		extensionErrors,
		manager,
		replacement: (): SessionManager | undefined => replacement,
		session,
		warnings,
		async dispose(): Promise<void> {
			try {
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				session.dispose();
				faux.unregister();
				if (previousAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
				else process.env[PI_AGENT_DIR_ENV] = previousAgentDir;
				if (options.agentDir === undefined) rmSync(agentDir, { recursive: true, force: true });
				if (options.cwd === undefined) rmSync(cwd, { recursive: true, force: true });
			}
		},
	};
}

async function waitFor(check: () => boolean, diagnostic = ""): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for host lifecycle work. ${diagnostic}`);
}

function containsSummary(contexts: readonly Context[]): boolean {
	return contexts.some((context) => JSON.stringify(context.messages).includes("HOST_MCTX_SUMMARY"));
}

test("real Pi host transforms context and retains it across reload", async (): Promise<void> => {
	const host = await createHost();
	try {
		assert.ok(
			host.session.extensionRunner
				?.getAllRegisteredTools()
				.some((tool) => tool.definition.name === "ctx_history"),
		);
		assert.deepEqual(
			host.session.extensionRunner
				?.getActiveTools()
				.filter((name) => ["ctx_reduce", "ctx_expand", "ctx_history"].includes(name))
				.sort(),
			["ctx_expand", "ctx_history", "ctx_reduce"],
		);
		// Memory-system tools are parked behind the disabled registration hook.
		assert.ok(
			!host.session.extensionRunner
				?.getAllRegisteredTools()
				.some((tool) => tool.definition.name === "ctx_memory"),
		);
		await host.session.prompt("Keep this newer parent turn raw.");
		await waitFor(() =>
			host.contexts.some((context) => context.systemPrompt?.includes("## Magic Context") === true),
		);
		await host.session.prompt("Keep another newer parent turn raw.");
		await host.session.prompt(LARGE_PROMPT);
		const usage = host.session.extensionRunner?.createContext().getContextUsage();
		await waitFor(
			() => host.contexts.some(isHistorianContext),
			`host errors: ${host.extensionErrors.join("; ")}; warnings: ${host.warnings.join("; ")}; contexts: ${host.contexts.length}; usage: ${JSON.stringify(usage)}; store: ${existsSync(join(host.agentDir, "mctx", "context.db"))}`,
		);
		await host.session.prompt("Render the already summarized context.");
		await waitFor(() => containsSummary(host.contexts));

		await host.session.reload();
		await host.session.prompt("Render the summary after reload.");
		await waitFor(() => containsSummary(host.contexts.slice(-4)));
	} finally {
		await host.dispose();
	}
});

test("real Pi host reports an MCTX error when manual compact cannot publish", async (): Promise<void> => {
	const host = await createHost({ executeThresholdTokens: 1_000_000, invalidHistorian: true });
	try {
		await host.session.prompt("First completed turn before failed manual compact.");
		await host.session.prompt("Second completed turn before failed manual compact.");
		await host.session.prompt(LARGE_PROMPT);
		await assert.rejects(host.session.compact(), /Compaction cancelled/);
		assert.ok(
			host.warnings.some((warning) => warning.startsWith("MCTX compact failed:")),
			`warnings: ${host.warnings.join("; ")}`,
		);
	} finally {
		await host.dispose();
	}
});

test("real Pi host builds an MCTX compartment for manual compact", async (): Promise<void> => {
	const host = await createHost({ executeThresholdTokens: 1_000_000 });
	try {
		await host.session.prompt("First completed turn before manual compact.");
		await host.session.prompt("Second completed turn before manual compact.");
		await host.session.prompt(LARGE_PROMPT);
		const before = host.manager.getEntries().length;
		await host.session.compact();
		const markers = host.manager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "compaction" &&
					entry.details !== null &&
					typeof entry.details === "object" &&
					"source" in entry.details &&
					entry.details.source === "pi-mctx",
			);
		assert.equal(markers.length, 1, `host errors: ${host.extensionErrors.join("; ")}`);
		assert.ok(markers[0]?.summary.includes("HOST_MCTX_SUMMARY"));
		assert.equal(host.manager.getEntries().length, before + 1);
	} finally {
		await host.dispose();
	}
});

test("real Pi host replaces native compact with an MCTX same-session marker", async (): Promise<void> => {
	const host = await createHost();
	try {
		await host.session.prompt("Keep this newer parent turn raw.");
		await host.session.prompt("Keep another newer parent turn raw.");
		await host.session.prompt(LARGE_PROMPT);
		await waitFor(() => host.contexts.some(isHistorianContext));
		await host.session.prompt("Render the already summarized context before compact.");
		await waitFor(() => containsSummary(host.contexts));

		const before = host.manager.getEntries().length;
		await host.session.compact();
		const markers = host.manager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "compaction" &&
					entry.details !== null &&
					typeof entry.details === "object" &&
					"source" in entry.details &&
					entry.details.source === "pi-mctx",
			);
		assert.equal(markers.length, 1, `host errors: ${host.extensionErrors.join("; ")}`);
		const marker = markers[0];
		assert.ok(marker, "expected an MCTX compaction marker");
		assert.ok(marker.summary.includes("HOST_MCTX_SUMMARY"));
		assert.ok(marker.firstKeptEntryId.length > 0);
		assert.equal(host.manager.getEntries().length, before + 1);
		assert.equal(host.replacement(), undefined);
	} finally {
		await host.dispose();
	}
});

test("real Pi host keeps MCTX tools out of the active set when runtime is disabled", async (): Promise<void> => {
	const host = await createHost({ runtimeEnabled: false });
	try {
		assert.deepEqual(
			host.session.extensionRunner
				?.getActiveTools()
				.filter((name) => ["ctx_reduce", "ctx_expand", "ctx_history"].includes(name)),
			[],
		);
	} finally {
		await host.dispose();
	}
});

test("real Pi host projects verified parent compartments into a fork", async (): Promise<void> => {
	const parent = await createHost();
	let child: HostFixture | undefined;
	try {
		await parent.session.prompt("Keep this newer parent turn raw.");
		await parent.session.prompt("Keep another newer parent turn raw.");
		await parent.session.prompt(LARGE_PROMPT);
		await waitFor(() => parent.contexts.some(isHistorianContext));
		const parentPath = parent.manager.getSessionFile();
		if (parentPath === undefined) throw new Error("Expected persisted parent session");
		const childManager = SessionManager.forkFrom(
			parentPath,
			parent.cwd,
			join(parent.agentDir, "sessions"),
		);
		child = await createHost({ agentDir: parent.agentDir, cwd: parent.cwd, manager: childManager });
		await child.session.prompt("Render inherited compressed context.");
		await waitFor(() => containsSummary(child?.contexts ?? []));
	} finally {
		await child?.dispose();
		await parent.dispose();
	}
});

test("real Pi host reports historian failure without replacing raw context", async (): Promise<void> => {
	const host = await createHost({ invalidHistorian: true });
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (value: unknown): void => {
		warnings.push(String(value));
	};
	try {
		await host.session.prompt("Keep this newer parent turn raw.");
		await host.session.prompt("Keep another newer parent turn raw.");
		await host.session.prompt(LARGE_PROMPT);
		await waitFor(() => warnings.some((warning) => warning.includes("pi-mctx.historian_failure")));
		assert.ok(
			host.warnings.includes("pi-mctx historian failed (validation); keeping existing context"),
		);
		assert.equal(containsSummary(host.contexts), false);
	} finally {
		console.warn = originalWarn;
		await host.dispose();
	}
});

test("real Pi host hands off through selected MCTX projection without native compact", async (): Promise<void> => {
	const host = await createHost({ includeHandoff: true });
	try {
		assert.ok(
			host.session.extensionRunner?.getCommand("handoff"),
			`handoff command missing; host errors: ${host.extensionErrors.join("; ")}`,
		);
		await host.session.prompt("Keep this newer parent turn raw.");
		await host.session.prompt("Keep another newer parent turn raw.");
		await host.session.prompt(LARGE_PROMPT);
		await waitFor(() => host.contexts.some(isHistorianContext));
		await host.session.prompt("Render the already summarized context before handoff.");
		await waitFor(() => containsSummary(host.contexts));

		const contextsBeforeHandoff = host.contexts.length;
		await host.session.prompt("/handoff");

		const replacement = host.replacement();
		assert.ok(
			replacement,
			`expected replacement; host errors: ${host.extensionErrors.join("; ")}; warnings: ${host.warnings.join("; ")}`,
		);
		const entries = replacement.getEntries();
		const projection = entries.find(
			(entry) => entry.type === "custom_message" && entry.customType === "mctx-parent-context",
		);
		assert.ok(projection, "handoff replacement must contain MCTX parent context");
		assert.equal(
			entries.some(
				(entry) => entry.type === "custom_message" && entry.customType === "hepi-handoff",
			),
			false,
			"selected MCTX handoff must not append native compact summary",
		);
		assert.equal(
			host.contexts.length,
			contextsBeforeHandoff,
			"selected MCTX handoff must not invoke native compact",
		);
	} finally {
		await host.dispose();
	}
});
