#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { lock } from "proper-lockfile";
import {
	DEFAULT_REPLAY_COLUMNS,
	DEFAULT_REPLAY_ROWS,
	finalFrameAnsi,
	isReplayKey,
	type ReplayAction,
	type ReplayComponent,
	type ReplayFrame,
	type ReplayHost,
	replayTui,
	sanitizeAnsi,
	stripAnsi,
	writeReplayArtifacts,
} from "./tui-replay.js";

type JournalAction = Exclude<ReplayAction, { readonly type: "model" }>;

interface ReplaySessionState {
	readonly version: 1;
	readonly kind: "session";
	readonly generation: string;
	readonly cwd: string;
	readonly columns: number;
	readonly rows: number;
	readonly rootDir: string;
	readonly modulePath?: string;
	readonly actions: readonly JournalAction[];
}

interface ReplaySessionTombstone {
	readonly version: 1;
	readonly kind: "reset";
	readonly generation: string;
}

type StoredReplaySession = ReplaySessionState | ReplaySessionTombstone;

interface StateDirectoryIdentity {
	readonly path: string;
	readonly device: number;
	readonly inode: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ReplaySessionCliOptions {
	readonly cwd?: string;
	readonly stateDir?: string;
	readonly write?: (text: string) => void;
}

const HELP = `Usage:
  replay start [--module scenario.ts] [--columns 50] [--rows 35] [--root outputs]
  replay key <name>
  replay send <text>
  replay input <JSON string>
  replay resize <columns> [rows]
  replay wait [ms]
  replay show
  replay save [root]
  replay status
  replay reset

Options:
  --session <name>  select a journal for the current working directory

Each command is a separate process. Actions persist in a journal and replay from the initial
component on every call. Use -- before send/input text that begins with a dash.`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const journalActionValidators: Readonly<
	Record<string, (value: Record<string, unknown>) => boolean>
> = {
	input: (value) => typeof value.data === "string",
	key: (value) => typeof value.key === "string" && isReplayKey(value.key),
	text: (value) => typeof value.text === "string",
	resize: (value) =>
		(value.columns === undefined || isPositiveInteger(value.columns)) &&
		(value.rows === undefined || isPositiveInteger(value.rows)) &&
		(value.columns !== undefined || value.rows !== undefined),
	wait: (value) => typeof value.ms === "number" && Number.isFinite(value.ms) && value.ms >= 0,
};

function isJournalAction(value: unknown): value is JournalAction {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	const validator = Object.hasOwn(journalActionValidators, value.type)
		? journalActionValidators[value.type]
		: undefined;
	return validator?.(value) ?? false;
}

function isReplaySessionState(value: unknown): value is ReplaySessionState {
	return (
		isRecord(value) &&
		value.version === 1 &&
		value.kind === "session" &&
		typeof value.generation === "string" &&
		UUID.test(value.generation) &&
		typeof value.cwd === "string" &&
		isPositiveInteger(value.columns) &&
		isPositiveInteger(value.rows) &&
		typeof value.rootDir === "string" &&
		(value.modulePath === undefined || typeof value.modulePath === "string") &&
		Array.isArray(value.actions) &&
		value.actions.every(isJournalAction)
	);
}

function isStoredReplaySession(value: unknown): value is StoredReplaySession {
	return (
		isReplaySessionState(value) ||
		(isRecord(value) &&
			value.version === 1 &&
			value.kind === "reset" &&
			typeof value.generation === "string" &&
			UUID.test(value.generation))
	);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function nonNegativeNumber(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`);
	return parsed;
}

function singleValue(values: readonly string[] | undefined, name: string): string | undefined {
	if (values !== undefined && values.length > 1)
		throw new Error(`${name} may be provided only once`);
	return values?.[0];
}

function sessionStatePath(stateDir: string, cwd: string, sessionName: string): string {
	if (sessionName.trim() === "") throw new Error("--session must not be blank");
	const id = createHash("sha256").update(cwd).update("\0").update(sessionName).digest("hex");
	return join(stateDir, `${id}.json`);
}

function defaultState(cwd: string, generation: string = randomUUID()): ReplaySessionState {
	return {
		version: 1,
		kind: "session",
		generation,
		cwd,
		columns: DEFAULT_REPLAY_COLUMNS,
		rows: DEFAULT_REPLAY_ROWS,
		rootDir: join(cwd, "outputs"),
		actions: [],
	};
}

function resetState(): ReplaySessionTombstone {
	return { version: 1, kind: "reset", generation: randomUUID() };
}

async function readState(path: string): Promise<StoredReplaySession | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Replay session state is not valid JSON: ${path}`, { cause: error });
	}
	if (!isStoredReplaySession(value)) throw new Error(`Replay session state is invalid: ${path}`);
	return value;
}

function stateDirectoryIdentity(path: string, info: Stats): StateDirectoryIdentity {
	if (info.isSymbolicLink())
		throw new Error(`Replay state directory must not be a symlink: ${path}`);
	if (!info.isDirectory()) throw new Error(`Replay state path is not a directory: ${path}`);
	const getuid = process.getuid;
	if (getuid !== undefined && info.uid !== getuid())
		throw new Error(`Replay state directory is not owned by the current user: ${path}`);
	if ((info.mode & 0o777) !== 0o700)
		throw new Error(`Replay state directory must have mode 0700: ${path}`);
	return { path, device: info.dev, inode: info.ino };
}

async function assertSecureParentChain(path: string): Promise<void> {
	const getuid = process.getuid;
	for (let current = dirname(path); ; current = dirname(current)) {
		const parent = await lstat(current);
		if (parent.isSymbolicLink())
			throw new Error(`Replay state directory parent must not be a symlink: ${current}`);
		if (!parent.isDirectory())
			throw new Error(`Replay state directory parent is not a directory: ${current}`);
		const parentIsMutable = (parent.mode & 0o022) !== 0;
		const parentIsSticky = (parent.mode & 0o1000) !== 0;
		const trustedOwner = getuid !== undefined && (parent.uid === 0 || parent.uid === getuid());
		if (!trustedOwner)
			throw new Error(`Replay state directory ancestor has an untrusted owner: ${current}`);
		if (parentIsMutable && !parentIsSticky)
			throw new Error(`Replay state directory parent is writable by another user: ${current}`);
		const next = dirname(current);
		if (next === current) return;
	}
}

async function ensureStateDirectory(path: string): Promise<StateDirectoryIdentity> {
	let info: Stats;
	try {
		info = await lstat(path);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
		await mkdir(path, { recursive: true, mode: 0o700 });
		info = await lstat(path);
	}
	stateDirectoryIdentity(path, info);
	const canonicalPath = await realpath(path);
	const identity = stateDirectoryIdentity(canonicalPath, await lstat(canonicalPath));
	await assertSecureParentChain(canonicalPath);
	return identity;
}

async function assertStateDirectory(path: string, expected: StateDirectoryIdentity): Promise<void> {
	const current = stateDirectoryIdentity(path, await lstat(path));
	if (current.device !== expected.device || current.inode !== expected.inode)
		throw new Error(`Replay state directory changed while acquiring its lock: ${path}`);
}

async function withStateLock<T>(statePath: string, run: () => Promise<T>): Promise<T> {
	const prepared = await ensureStateDirectory(dirname(statePath));
	const release = await lock(statePath, {
		realpath: false,
		stale: 300_000,
		update: 10_000,
		retries: { retries: 100, minTimeout: 10, maxTimeout: 1_000 },
	});
	try {
		await assertStateDirectory(prepared.path, prepared);
		return await run();
	} finally {
		await release();
	}
}

function stateRevision(state: StoredReplaySession | undefined): string {
	if (state === undefined) return "missing";
	return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

async function readLockedState(statePath: string): Promise<StoredReplaySession | undefined> {
	return await withStateLock(statePath, async () => await readState(statePath));
}

async function initializeStoredState(statePath: string): Promise<StoredReplaySession> {
	return await withStateLock(statePath, async () => {
		const current = await readState(statePath);
		if (current !== undefined) return current;
		const initial = resetState();
		await writeState(statePath, initial);
		return initial;
	});
}

async function commitState(
	statePath: string,
	expectedRevision: string,
	next: StoredReplaySession,
): Promise<boolean> {
	return await withStateLock(statePath, async () => {
		const current = await readState(statePath);
		if (stateRevision(current) !== expectedRevision) return false;
		await writeState(statePath, next);
		return true;
	});
}

async function assertSessionGeneration(statePath: string, generation: string): Promise<void> {
	await withStateLock(statePath, async () => {
		const current = await readState(statePath);
		if (current?.generation !== generation)
			throw new Error("Replay session was reset or restarted while the command was running");
	});
}

async function publishForGeneration(
	statePath: string,
	generation: string,
	publish: () => Promise<string>,
): Promise<string> {
	return await withStateLock(statePath, async () => {
		const current = await readState(statePath);
		if (current?.generation !== generation)
			throw new Error("Replay session was reset or restarted while save was running");
		return await publish();
	});
}

async function writeState(path: string, state: StoredReplaySession): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function removeLastGrapheme(value: string): string {
	const last = [...GRAPHEME_SEGMENTER.segment(value)].at(-1);
	return last === undefined ? "" : value.slice(0, last.index);
}

function defaultComponent(host: ReplayHost): ReplayComponent {
	const transcript = ["Replay session"];
	let draft = "";
	return {
		render: () => [...transcript, `> ${draft}`],
		handleInput(data) {
			if (data === "\r") {
				transcript.push(`User: ${draft}`);
				draft = "";
			} else if (data === "\x7f") draft = removeLastGrapheme(draft);
			else draft += data;
			host.requestRender();
		},
	};
}

function isReplayComponent(value: unknown): value is ReplayComponent {
	if (!isRecord(value) || typeof value.render !== "function") return false;
	for (const name of ["handleInput", "handleModelResult", "invalidate"] as const) {
		const member = value[name];
		if (member !== undefined && typeof member !== "function") return false;
	}
	return true;
}

function isReplayScenarioModule(
	value: unknown,
): value is { readonly default: (host: ReplayHost) => unknown } {
	return isRecord(value) && typeof value.default === "function";
}

async function loadComponentFactory(
	modulePath: string | undefined,
): Promise<(host: ReplayHost) => ReplayComponent> {
	if (modulePath === undefined) return defaultComponent;
	const loaded: unknown = await import(`${pathToFileURL(modulePath).href}?v=${randomUUID()}`);
	if (!isReplayScenarioModule(loaded))
		throw new Error("Replay module must default-export a component factory");
	return (host) => {
		const component = loaded.default(host);
		if (!isReplayComponent(component))
			throw new Error("Replay module factory must return a ReplayComponent");
		return component;
	};
}

async function renderState(state: ReplaySessionState) {
	const create = await loadComponentFactory(state.modulePath);
	return await replayTui({
		columns: state.columns,
		rows: state.rows,
		create,
		actions: state.actions,
	});
}

function frameText(frame: ReplayFrame): string {
	return finalFrameAnsi(frame).trimEnd();
}

function exactPositionals(
	positionals: readonly string[],
	minimum: number,
	maximum: number,
	usage: string,
): readonly string[] {
	if (positionals.length < minimum || positionals.length > maximum) throw new Error(usage);
	return positionals;
}

function actionFromCommand(command: string, args: readonly string[]): JournalAction | undefined {
	switch (command) {
		case "key": {
			const [, key] = exactPositionals(args, 2, 2, "key requires <name>");
			if (key === undefined || !isReplayKey(key)) throw new Error(`Unsupported replay key: ${key}`);
			return { type: "key", key };
		}
		case "send": {
			const text = exactPositionals(args, 2, Number.MAX_SAFE_INTEGER, "send requires <text>")
				.slice(1)
				.join(" ");
			return { type: "text", text };
		}
		case "input": {
			const [, raw] = exactPositionals(args, 2, 2, "input requires one JSON string");
			let value: unknown;
			try {
				value = JSON.parse(raw ?? "");
			} catch {
				throw new Error("input requires a valid JSON string");
			}
			if (typeof value !== "string") throw new Error("input requires a JSON string");
			return { type: "input", data: value };
		}
		case "resize": {
			const [, rawColumns, rawRows] = exactPositionals(
				args,
				2,
				3,
				"resize requires <columns> [rows]",
			);
			if (rawColumns === undefined) throw new Error("resize requires <columns> [rows]");
			return {
				type: "resize",
				columns: positiveInteger(rawColumns, "columns"),
				...(rawRows === undefined ? {} : { rows: positiveInteger(rawRows, "rows") }),
			};
		}
		case "wait": {
			const [, rawMs] = exactPositionals(args, 1, 2, "wait accepts optional [ms]");
			return { type: "wait", ms: nonNegativeNumber(rawMs ?? "100", "wait ms") };
		}
		default:
			return undefined;
	}
}

export async function runReplaySessionCli(
	args: readonly string[],
	options: ReplaySessionCliOptions = {},
): Promise<void> {
	const { values, positionals } = parseArgs({
		args: [...args],
		allowPositionals: true,
		strict: true,
		options: {
			help: { type: "boolean", short: "h" },
			session: { type: "string", multiple: true },
			module: { type: "string", multiple: true },
			columns: { type: "string", multiple: true },
			rows: { type: "string", multiple: true },
			root: { type: "string", multiple: true },
		},
	});
	const writeOutput = options.write ?? console.log;
	const write = (text: string): void => writeOutput(sanitizeAnsi(text));
	if (values.help) {
		write(HELP);
		return;
	}
	if (process.platform === "win32")
		throw new Error("The replay session CLI currently requires a POSIX platform");
	const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
	const configuredStateDir = options.stateDir ?? process.env.PI_TUI_REPLAY_STATE_DIR;
	if (configuredStateDir !== undefined && configuredStateDir.trim() === "")
		throw new Error("Replay state directory must not be blank");
	const stateDir = (
		await ensureStateDirectory(
			resolve(configuredStateDir ?? join(homedir(), ".pi", "agent", "replay-sessions")),
		)
	).path;
	const sessionName = singleValue(values.session, "--session") ?? "default";
	const moduleValue = singleValue(values.module, "--module");
	const columnsValue = singleValue(values.columns, "--columns");
	const rowsValue = singleValue(values.rows, "--rows");
	const rootValue = singleValue(values.root, "--root");
	const statePath = sessionStatePath(stateDir, cwd, sessionName);
	const command = positionals[0];
	if (command === undefined) throw new Error("Missing replay command. Use --help for usage.");

	if (command === "start") {
		exactPositionals(positionals, 1, 1, "start does not accept positional arguments");
		const existing = await initializeStoredState(statePath);
		if (existing.kind === "session")
			throw new Error(`Replay session already exists: ${sessionName}. Run replay reset first.`);
		const state: ReplaySessionState = {
			version: 1,
			kind: "session",
			generation: randomUUID(),
			cwd,
			columns: positiveInteger(columnsValue ?? String(DEFAULT_REPLAY_COLUMNS), "columns"),
			rows: positiveInteger(rowsValue ?? String(DEFAULT_REPLAY_ROWS), "rows"),
			rootDir: resolve(cwd, rootValue ?? "outputs"),
			...(moduleValue === undefined ? {} : { modulePath: resolve(cwd, moduleValue) }),
			actions: [],
		};
		const result = await renderState(state);
		if (!(await commitState(statePath, stateRevision(existing), state)))
			throw new Error(`Replay session changed while start was running: ${sessionName}`);
		write(frameText(result.last));
		return;
	}
	if (
		moduleValue !== undefined ||
		columnsValue !== undefined ||
		rowsValue !== undefined ||
		rootValue !== undefined
	)
		throw new Error("--module, --columns, --rows, and --root are only valid with start");

	if (command === "reset") {
		exactPositionals(positionals, 1, 1, "reset does not accept arguments");
		await withStateLock(statePath, async () => await writeState(statePath, resetState()));
		write(`Reset replay session: ${sessionName}`);
		return;
	}

	const action = actionFromCommand(command, positionals);
	if (action !== undefined) {
		let expectedGeneration: string | undefined;
		for (let attempt = 0; attempt < 10; attempt++) {
			const saved =
				attempt === 0 ? await initializeStoredState(statePath) : await readLockedState(statePath);
			if (saved === undefined)
				throw new Error("Replay session state disappeared while the command was running");
			if (expectedGeneration === undefined) expectedGeneration = saved.generation;
			else if (saved.generation !== expectedGeneration)
				throw new Error("Replay session was reset or restarted while the command was running");
			const state = saved.kind === "session" ? saved : defaultState(cwd, saved.generation);
			const next: ReplaySessionState = { ...state, actions: [...state.actions, action] };
			const result = await renderState(next);
			if (await commitState(statePath, stateRevision(saved), next)) {
				write(frameText(result.last));
				return;
			}
		}
		throw new Error("Replay session changed repeatedly; retry the command");
	}

	const saved = await initializeStoredState(statePath);
	const state = saved.kind === "session" ? saved : defaultState(cwd, saved.generation);
	if (command === "show") {
		exactPositionals(positionals, 1, 1, "show does not accept arguments");
		const result = await renderState(state);
		await assertSessionGeneration(statePath, state.generation);
		write(frameText(result.last));
		return;
	}
	if (command === "save") {
		const [, outputRoot] = exactPositionals(positionals, 1, 2, "save accepts optional [root]");
		const artifacts = await writeReplayArtifacts(await renderState(state), {
			rootDir: outputRoot === undefined ? state.rootDir : resolve(cwd, outputRoot),
			publish: async (publish) => await publishForGeneration(statePath, state.generation, publish),
		});
		write(artifacts.directory);
		return;
	}
	if (command === "status") {
		exactPositionals(positionals, 1, 1, "status does not accept arguments");
		write(
			JSON.stringify(
				{
					session: sessionName,
					generation: state.generation,
					active: saved.kind === "session",
					statePath,
					modulePath: state.modulePath ?? null,
					columns: state.columns,
					rows: state.rows,
					actions: state.actions.length,
				},
				null,
				2,
			),
		);
		return;
	}
	throw new Error(`Unknown replay command: ${command}`);
}

if (import.meta.main) {
	try {
		await runReplaySessionCli(process.argv.slice(2));
		await new Promise<void>((resolveWrite, rejectWrite) =>
			process.stdout.write("", (error) => {
				if (error) rejectWrite(error);
				else resolveWrite();
			}),
		);
		process.exit(0);
	} catch (error) {
		const message = stripAnsi(
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		);
		await new Promise<void>((resolveWrite, rejectWrite) =>
			process.stderr.write(`${message}\n`, (writeError) => {
				if (writeError) rejectWrite(writeError);
				else resolveWrite();
			}),
		);
		process.exit(1);
	}
}
