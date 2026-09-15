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
		if (method === "GET" && path === "/agentmemory/health")
			return void response.end('{"status":"healthy"}');
		if (method === "POST" && path === "/agentmemory/session/start")
			return void response.end('{"session":{"id":"fixture-session"}}');
		if (method === "POST" && path === "/agentmemory/observe")
			return void response.end('{"observationId":"fixture-observation"}');
		if (method === "POST" && path === "/agentmemory/search") {
			return void response.end(
				JSON.stringify({
					results: [
						{
							id: "fixture-memory",
							content: "fixture durable memory",
							project: "pi-mctx-agentmemory-smoke",
							score: 0.9,
						},
					],
				}),
			);
		}
		if (method === "POST" && path === "/agentmemory/remember")
			return void response.end('{"success":true,"memory":{"id":"fixture-saved-memory"}}');
		if (method === "POST" && path === "/agentmemory/session/end")
			return void response.end('{"ended":true}');
		response.statusCode = 404;
		response.end(JSON.stringify({ error: "unsupported fixture route" }));
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

function writeSettings(agentDir: string, fixtureUrl: string, windowEnabled: boolean): void {
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[FIXTURE_PROVIDER]: {
						baseUrl: fixtureUrl,
						api: "openai-completions",
						apiKey: "fixture-no-network",
						models: [{ id: FIXTURE_MODEL, contextWindow: 32768, maxTokens: 1024 }],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				defaultProvider: FIXTURE_PROVIDER,
				defaultModel: FIXTURE_MODEL,
				defaultThinkingLevel: "off",
				compaction: { enabled: false },
				"pi-mctx": {
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
			},
			null,
			2,
		)}\n`,
	);
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
			`Window ${WINDOW_DISABLED ? "disabled" : "enabled"}; AgentMemory fixture provider ${FIXTURE_PROVIDER}`,
		);
		runtime = await startRuntime(cwd, agentDir, sessionManager);
		const host = runtime.session.extensionRunner;
		const registered = runtime.session.getAllTools().map((tool) => tool.name);
		if (!registered.includes("mctx_search") || !registered.includes("mctx_memory"))
			fail("AgentMemory tools were not registered by Pi host");
		pass("Pi host registered AgentMemory tool surface");

		await waitFor(
			"capture session start",
			() => countRequests(fixture, "POST", "/agentmemory/session/start") === 1,
		);
		if (countRequests(fixture, "GET", "/agentmemory/health") !== 1)
			fail("session start did not health-check fixture exactly once");
		pass("enabled capture starts fixture session after health check");

		const beforeStatus = fixture.requests.length;
		await runtime.session.prompt("/ctx-status");
		if (fixture.requests.length !== beforeStatus) fail("/ctx-status performed network I/O");
		await runtime.session.prompt("/agentmemory-health");
		if (countRequests(fixture, "GET", "/agentmemory/health") !== 2)
			fail("/agentmemory-health did not make explicit health request");
		pass("status is observed-only; explicit health probes fixture");

		const context = runtime.session.extensionRunner.createContext();
		const search =
			runtime.session.getToolDefinition("mctx_search") ?? fail("missing mctx_search definition");
		const searchResult = await search.execute(
			"fixture-search",
			{ query: "fixture durable memory", limit: 3 },
			undefined,
			undefined,
			context as never,
		);
		const searchText = searchResult.content[0]?.text ?? "";
		if (
			!searchText.includes("Durable AgentMemory lane") ||
			!searchText.includes("fixture durable memory")
		)
			fail("mctx_search did not render fixture durable result");
		pass("mctx_search reached fixture durable lane");

		const memory =
			runtime.session.getToolDefinition("mctx_memory") ?? fail("missing mctx_memory definition");
		const saveResult = await memory.execute(
			"fixture-save",
			{ content: "smoke durable fact", type: "fact" },
			undefined,
			undefined,
			context as never,
		);
		if (!saveResult.content[0]?.text.includes("queued"))
			fail("mctx_memory did not queue durable memory");
		await waitFor(
			"outbox remember delivery",
			() => countRequests(fixture, "POST", "/agentmemory/remember") === 1,
		);
		pass("mctx_memory queued and delivered outbox record");

		await runtime.session.prompt("recall fixture durable memory");
		const providerRequest = fixture.requests.find(
			(request) => request.path === "/chat/completions",
		);
		if (!JSON.stringify(providerRequest?.body).includes("AgentMemory recall for this user turn"))
			fail("automatic recall did not reach actual provider request");
		await waitFor(
			"capture prompt observation",
			() => countRequests(fixture, "POST", "/agentmemory/observe") >= 1,
		);
		pass("enabled capture observed prompt through fixture session");
		const projected = await host.emitContext(runtime.session.messages);
		const recallCount = countRequests(fixture, "POST", "/agentmemory/search");
		if (
			!projected.some((message) =>
				JSON.stringify(message).includes("AgentMemory recall for this user turn"),
			)
		) {
			console.error(`RECALL_DIAGNOSTICS ${projectionDebug(projected, fixture, logPath)}`);
			fail("automatic recall was not projected into provider context");
		}
		const sessionFile =
			runtime.session.sessionFile ?? fail("Pi host did not persist session JSONL");
		if (readFileSync(sessionFile, "utf8").includes("AgentMemory recall for this user turn"))
			fail("automatic recall leaked into session JSONL");
		await host.emitContext(runtime.session.messages);
		if (countRequests(fixture, "POST", "/agentmemory/search") !== recallCount)
			fail("repeat context transform re-searched instead of replaying recall ledger");
		pass("automatic recall projects once into provider context and stays out of JSONL");

		await host.emit({ type: "session_shutdown", reason: "shutdown" });
		await waitFor(
			"fixture session end",
			() => countRequests(fixture, "POST", "/agentmemory/session/end") === 1,
		);
		pass("session shutdown drains and ends fixture session");
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
