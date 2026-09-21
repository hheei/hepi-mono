#!/usr/bin/env -S node --no-warnings --import jiti/register
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
/**
 * AgentMemory protocol-integration smoke using Pi's SDK lifecycle.
 *
 * Run: pnpm --filter @hheei/pi-mctx exec node --no-warnings --import jiti/register scripts/agentmemory-live-smoke.ts [--window-off]
 *
 * This intentionally uses a local HTTP fixture and the explicit `agentmemory-fixture`
 * Pi provider. It validates our AgentMemory protocol integration, not a deployed
 * AgentMemory service or interactive TUI rendering.
 */
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import magicContext from "../src/index.ts";

type FixtureRequest = { readonly method: string; readonly path: string; readonly body: unknown };
type Fixture = {
	readonly url: string;
	readonly requests: FixtureRequest[];
	readonly close: () => Promise<void>;
};

const TIMEOUT_MS = 10_000;
const FIXTURE_PROVIDER = "agentmemory-fixture";
const FIXTURE_MODEL = "no-network-model";
const WINDOW_DISABLED = process.argv.includes("--window-off");

function fail(message: string): never {
	throw new Error(message);
}

function pass(message: string): void {
	console.log(`PASS ${message}`);
}

function requestPath(request: FixtureRequest): string {
	return `${request.method} ${request.path}`;
}

function countRequests(fixture: Fixture, method: string, path: string): number {
	return fixture.requests.filter((request) => request.method === method && request.path === path)
		.length;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		fail(`fixture received invalid JSON: ${text}`);
	}
}

function projectionDebug(messages: readonly unknown[], fixture: Fixture, logPath: string): string {
	const hostLog = existsSync(logPath)
		? readFileSync(logPath, "utf8").slice(-4_000)
		: "(no host log)";
	return JSON.stringify({
		messages: messages.map((message) => {
			if (message === null || typeof message !== "object" || Array.isArray(message))
				return typeof message;
			const entry = message as Record<string, unknown>;
			return { role: entry.role, synthetic: entry.synthetic, content: entry.content };
		}),
		fixtureCalls: fixture.requests.map(requestPath),
		hostLog,
	});
}

async function startFixture(): Promise<Fixture> {
	const requests: FixtureRequest[] = [];
	const server = createServer(async (request, response) => {
		const method = request.method ?? "";
		const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const body = await readJson(request);
		requests.push({ method, path, body });
		response.setHeader("content-type", "application/json");
		if (method === "POST" && path === "/chat/completions") {
			response.setHeader("content-type", "text/event-stream");
			const chunk = {
				id: "fixture-completion",
				object: "chat.completion.chunk",
				created: 0,
				model: FIXTURE_MODEL,
			};
			response.write(
				`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture answer." }, finish_reason: null }] })}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
			);
			return void response.end("data: [DONE]\n\n");
		}
		if (method === "GET" && path === "/version")
			return void response.end('{"api_version":"0.10","features":{}}');
		if (method === "POST" && /\/v1\/default\/banks\/[^/]+\/memories$/.test(path))
			return void response.end(
				'{"success":true,"bank_id":"pi-mctx-agentmemory-smoke","items_count":1,"async":true,"operation_id":"fixture-operation"}',
			);
		if (method === "POST" && /\/v1\/default\/banks\/[^/]+\/memories\/recall$/.test(path))
			return void response.end(
				JSON.stringify({
					results: [
						{
							id: "fixture-memory",
							text: "fixture durable memory",
							type: "world",
						},
					],
				}),
			);
		response.statusCode = 404;
		response.end(JSON.stringify({ error: "unsupported Hindsight fixture route" }));
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") fail("fixture did not receive a TCP address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: async () => {
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close((error) => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		},
	};
}

function stubUi(): ExtensionUIContext {
	const noopAsync = async () => undefined;
	return {
		select: noopAsync,
		confirm: async () => false,
		input: noopAsync,
		notify() {},
		onTerminalInput: () => () => undefined,
		setStatus() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		pasteToEditor() {},
		setEditorText() {},
		getEditorText: () => "",
		editor: noopAsync,
		addAutocompleteProvider() {},
		setEditor() {},
		showOverlay() {
			return { close() {}, update() {} };
		},
		hideOverlay() {},
	} as ExtensionUIContext;
}

function waitFor(label: string, predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;
	const waited = Promise.withResolvers<void>();
	const tick = () => {
		if (predicate()) return waited.resolve();
		if (Date.now() >= deadline)
			return waited.reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`));
		setTimeout(tick, 25);
	};
	tick();
	return waited.promise;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSettings(agentDir: string, fixtureUrl: string, windowEnabled: boolean): void {
	writeJson(join(agentDir, "models.json"), {
		providers: {
			[FIXTURE_PROVIDER]: {
				baseUrl: fixtureUrl,
				api: "openai-completions",
				apiKey: "fixture-no-network",
				models: [{ id: FIXTURE_MODEL, contextWindow: 32768, maxTokens: 1024 }],
			},
		},
	});
	writeJson(join(agentDir, "settings.json"), {
		defaultProvider: FIXTURE_PROVIDER,
		defaultModel: FIXTURE_MODEL,
		defaultThinkingLevel: "off",
		compaction: { enabled: false },
	});
	writeJson(join(agentDir, "ext_settings.json"), {
		operational: {
			enabled: windowEnabled,
			compactionEnabled: false,
			historianEnabled: false,
			embeddingProvider: "off",
			dreamerEnabled: false,
			memoryEnabled: false,
			memoryAutoSearchEnabled: false,
			agentmemoryEnabled: true,
			agentmemoryUrl: fixtureUrl,
			agentmemorySecret: "",
			agentmemoryAgentId: "",
			agentmemoryCapture: true,
			agentmemoryInject: true,
			agentmemoryHistorianRetrieval: false,
			agentmemoryMemoryTools: true,
			agentmemoryRequireHttps: false,
		},
	});
}

async function startRuntime(
	cwd: string,
	agentDir: string,
	sessionManager: InstanceType<typeof SessionManager>,
) {
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [magicContext],
			},
		});
		const model =
			services.modelRuntime.getModel(FIXTURE_PROVIDER, FIXTURE_MODEL) ??
			fail("fixture model was not loaded");
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent ?? { type: "session_start", reason: "startup" },
			model,
			thinkingLevel: "off",
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
	const bind = async (session: AgentSession): Promise<void> => {
		await session.bindExtensions({
			uiContext: stubUi(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				switchSession: (path) => runtime.switchSession(path),
				fork: async (entryId, options) => ({
					cancelled: (await runtime.fork(entryId, options)).cancelled,
				}),
			},
		});
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return runtime;
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-agentmemory-smoke-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "pi-mctx-agentmemory-smoke");
	const logPath = join(root, "magic-context.log");
	const fixture = await startFixture();
	let runtime: AgentSessionRuntime | undefined;
	try {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		process.env.AGENTMEMORY_PROJECT_NAME = "pi-mctx-agentmemory-smoke";
		writeSettings(agentDir, fixture.url, !WINDOW_DISABLED);
		const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
		console.log(
			`Window ${WINDOW_DISABLED ? "disabled" : "enabled"}; Hindsight fixture provider ${FIXTURE_PROVIDER}`,
		);
		runtime = await startRuntime(cwd, agentDir, sessionManager);
		const host = runtime.session.extensionRunner;
		const registered = runtime.session.getAllTools().map((tool) => tool.name);
		if (!registered.includes("recall") || !registered.includes("retain"))
			fail("Hindsight tools were not registered by Pi host");
		pass("Pi host registered Hindsight tool surface");

		await waitFor(
			"Hindsight health/version",
			() => countRequests(fixture, "GET", "/version") === 1,
		);
		pass("enabled capture initializes Hindsight compatibility port");

		const beforeStatus = fixture.requests.length;
		await runtime.session.prompt("/ctx-status");
		if (fixture.requests.length !== beforeStatus) fail("/ctx-status performed network I/O");
		await runtime.session.prompt("/agentmemory-health");
		if (countRequests(fixture, "GET", "/version") !== 2)
			fail("/agentmemory-health did not make explicit Hindsight version request");
		pass("status is observed-only; explicit Hindsight probe is explicit");

		const context = runtime.session.extensionRunner.createContext();
		const search = runtime.session.getToolDefinition("recall") ?? fail("missing recall definition");
		const searchResult = await search.execute(
			"fixture-search",
			{ query: "fixture durable memory", limit: 3 },
			new AbortController().signal,
			undefined,
			context,
		);
		const searchText = searchResult.content[0]?.text ?? "";
		if (!searchText.includes("fixture durable memory"))
			fail("recall did not render fixture durable result");
		pass("recall reached Hindsight durable lane");

		const memory = runtime.session.getToolDefinition("retain") ?? fail("missing retain definition");
		const saveResult = await memory.execute(
			"fixture-save",
			{ content: "smoke durable fact", type: "fact" },
			new AbortController().signal,
			undefined,
			context,
		);
		if (!saveResult.content[0]?.text.includes("queued"))
			fail("retain did not queue durable memory");
		await waitFor("outbox retain delivery", () =>
			fixture.requests.some(
				(request) => request.method === "POST" && /\/memories$/.test(request.path),
			),
		);
		pass("retain queued and delivered Hindsight memory");

		await runtime.session.prompt("recall fixture durable memory");
		const providerRequest = fixture.requests.find(
			(request) => request.path === "/chat/completions",
		);
		if (!JSON.stringify(providerRequest?.body).includes("Hindsight recall for this user turn"))
			fail("automatic recall did not reach actual provider request");
		pass("enabled capture retained prompt through Hindsight fixture");
		const projected = await host.emitContext(runtime.session.messages);
		const recallCount = fixture.requests.filter(
			(request) => request.method === "POST" && /\/memories\/recall$/.test(request.path),
		).length;
		if (
			!projected.some((message) =>
				JSON.stringify(message).includes("Hindsight recall for this user turn"),
			)
		) {
			console.error(`RECALL_DIAGNOSTICS ${projectionDebug(projected, fixture, logPath)}`);
			fail("automatic recall was not projected into provider context");
		}
		const sessionFile =
			runtime.session.sessionFile ?? fail("Pi host did not persist session JSONL");
		if (readFileSync(sessionFile, "utf8").includes("Hindsight recall for this user turn"))
			fail("automatic recall leaked into session JSONL");
		await host.emitContext(runtime.session.messages);
		const repeatedRecallCount = fixture.requests.filter(
			(request) => request.method === "POST" && /\/memories\/recall$/.test(request.path),
		).length;
		if (repeatedRecallCount !== recallCount)
			fail("repeat context transform re-searched instead of replaying recall ledger");
		pass("automatic recall projects once into provider context and stays out of JSONL");

		await host.emit({ type: "session_shutdown", reason: "shutdown" });
		pass("session shutdown cleaned up Hindsight compatibility port");
		console.log(`fixture protocol calls: ${fixture.requests.map(requestPath).join(", ")}`);
	} finally {
		if (runtime) {
			await runtime.session.extensionRunner
				.emit({ type: "session_shutdown", reason: "shutdown" })
				.catch(() => undefined);
			runtime.session.dispose();
		}
		await fixture.close();
		rmSync(root, { recursive: true, force: true });
	}
}

await main();
