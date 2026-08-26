import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import piExtTools from "../dist/index.js";

interface Snapshot {
	readonly label: string;
	readonly model: string;
	readonly mutators: string[];
	readonly activeHasEval: boolean;
	readonly evalNested: string[];
	readonly evalPrompt: string | undefined;
	readonly promptMentionsNative: boolean;
	readonly promptMentionsPatch: boolean;
}

const USER = join(process.env.HOME ?? "/home/chlo", ".pi/agent");
const root = mkdtempSync(join(tmpdir(), "edit-catalog-smoke-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
copyFileSync(join(USER, "auth.json"), join(agentDir, "auth.json"));
try {
	copyFileSync(join(USER, "models.json"), join(agentDir, "models.json"));
} catch {}
writeFileSync(
	join(agentDir, "settings.json"),
	`${JSON.stringify(
		{
			defaultThinkingLevel: "off",
			compaction: { enabled: false },
			"pi-ext-tools": { edit: { mode: "auto" }, eval: { enabled: true } },
		},
		null,
		2,
	)}\n`,
);
process.env.PI_CODING_AGENT_DIR = agentDir;

const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	extensionFactories: [
		{
			factory: piExtTools,
			path: join(import.meta.dirname, "../dist/extension.js"),
		} as never,
	],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
	cwd,
	agentDir,
	resourceLoader,
	sessionManager: SessionManager.inMemory(cwd),
	thinkingLevel: "off",
});

const ui = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
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
	custom: async () => ({ status: "aborted" }),
	pasteToEditor() {},
	setEditorText() {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider() {},
	setEditor() {},
	showOverlay() {
		return { close() {}, update() {} };
	},
	hideOverlay() {},
} as unknown as ExtensionUIContext;

await session.bindExtensions({ uiContext: ui, mode: "rpc" });

function snapshot(label: string): Snapshot {
	const mutators = session
		.getActiveToolNames()
		.filter((name) => ["edit", "write", "apply_patch"].includes(name));
	const nested = (
		session.getAllTools().find((tool) => tool.name === "eval")?.promptGuidelines ?? []
	).filter(
		(line) =>
			line.includes("nested tools") ||
			line.includes("file changes") ||
			line.includes("File mutation"),
	);
	const evalPrompt = session.systemPrompt.match(/eval: nested tools[^\n]+/)?.[0];
	const data: Snapshot = {
		label,
		model: `${session.model?.provider}/${session.model?.id}`,
		mutators,
		activeHasEval: session.getActiveToolNames().includes("eval"),
		evalNested: nested,
		evalPrompt,
		promptMentionsNative: session.systemPrompt.includes("edit/write for file changes"),
		promptMentionsPatch: session.systemPrompt.includes("apply_patch for file changes"),
	};
	console.log(JSON.stringify(data, null, 2));
	return data;
}

const grok = session.modelRuntime.getModel("cx", "grok-4.6");
const gpt = session.modelRuntime.getModel("cx", "gpt-5.6-luna");
if (grok === undefined || gpt === undefined) {
	throw new Error(`missing models grok=${grok?.id} gpt=${gpt?.id}`);
}

const start = snapshot("after session_start");
await session.setModel(grok);
const afterGrok = snapshot("after grok");
await session.setModel(gpt);
const afterGpt = snapshot("after gpt");
await session.setModel(grok);
const afterGrokAgain = snapshot("after grok again");

function fail(message: string): never {
	throw new Error(message);
}

if (JSON.stringify(afterGrok.mutators) !== JSON.stringify(["edit", "write"])) {
	fail(`grok mutators ${JSON.stringify(afterGrok.mutators)}`);
}
if (JSON.stringify(afterGpt.mutators) !== JSON.stringify(["apply_patch"])) {
	fail(`gpt mutators ${JSON.stringify(afterGpt.mutators)}`);
}
if (JSON.stringify(afterGrokAgain.mutators) !== JSON.stringify(["edit", "write"])) {
	fail(`grok-again mutators ${JSON.stringify(afterGrokAgain.mutators)}`);
}
if (!String(afterGpt.evalNested).includes("apply_patch"))
	fail("gpt eval nested missing apply_patch");
if (!afterGpt.promptMentionsPatch) fail("gpt prompt missing apply_patch guideline");
if (!afterGrokAgain.promptMentionsNative) fail("grok prompt missing edit/write guideline");
if (afterGpt.evalPrompt?.includes("apply_patch") !== true)
	fail("gpt system prompt nested eval guideline missing apply_patch");
if (afterGpt.promptMentionsNative) fail("gpt prompt still mentions edit/write");
if (afterGrokAgain.evalPrompt?.includes("edit, and write") !== true)
	fail("grok system prompt nested eval guideline missing native tools");
if (afterGrokAgain.promptMentionsPatch) fail("grok prompt still mentions apply_patch");
console.log("PASS", { start: start.mutators, root });
await session.abort();
