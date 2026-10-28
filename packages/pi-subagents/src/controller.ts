import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";
import { closeControllerIpc, serveControllerIpc } from "./controller-ipc.js";
import { beginControllerRole, type ControllerRole, endControllerRole } from "./controller-role.js";
import piSubagentsExtension, { skillCatalogFromLoaded } from "./extension.js";
import { holdProcessLock, type ProcessLock } from "./process-lock.js";

export type StandaloneControllerFailure = "busy" | "model_unavailable";

export class StandaloneControllerError extends Error {
	readonly code: StandaloneControllerFailure;
	readonly parentSessionId: string | undefined;

	constructor(code: StandaloneControllerFailure, message: string, parentSessionId?: string) {
		super(message);
		this.name = "StandaloneControllerError";
		this.code = code;
		this.parentSessionId = parentSessionId;
	}
}

export interface StandaloneController {
	readonly workspace: string;
	readonly parentSessionId: string;
	readonly sessionFile: string;
	readonly socketPath: string;
	dispose(): Promise<void>;
}

export function controllerSocketPath(agentDir: string, workspace: string): string {
	return join(controllerDirectory(resolve(agentDir)), `${workspaceKey(resolve(workspace))}.sock`);
}

interface ControllerBinding {
	readonly workspace: string;
	readonly parentSessionId: string;
	readonly sessionFile: string;
}

export async function startStandaloneController(options: {
	readonly workspace: string;
	readonly agentDir: string;
}): Promise<StandaloneController> {
	const workspace = resolve(options.workspace);
	const agentDir = resolve(options.agentDir);
	const directory = controllerDirectory(agentDir);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const id = workspaceKey(workspace);
	const lock = lockController(join(directory, `${id}.lock`));
	let role: ControllerRole | undefined;
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	try {
		const bindingPath = join(directory, `${id}.json`);
		const existing = readBinding(bindingPath);
		if (existing !== undefined && existing.workspace !== workspace) {
			throw new Error("Standalone controller binding does not match this workspace");
		}
		const sessionDir = join(agentDir, "subagents", "sessions");
		const sessionManager =
			existing === undefined
				? SessionManager.create(workspace, sessionDir)
				: existsSync(existing.sessionFile)
					? SessionManager.open(existing.sessionFile)
					: // Pi writes the session file only after a user or assistant message.
						SessionManager.create(workspace, sessionDir, { id: existing.parentSessionId });
		const sessionFile = sessionManager.getSessionFile();
		const parentSessionId = sessionManager.getSessionId();
		if (sessionFile === undefined) throw new Error("Standalone controller session has no file");
		if (existing !== undefined && existing.parentSessionId !== parentSessionId) {
			throw new Error("Standalone controller restored a different parent session");
		}
		writeBinding(bindingPath, { workspace, parentSessionId, sessionFile });
		runtime = await createAgentSessionRuntime(
			async ({ cwd, sessionManager: bound }) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					resourceLoaderOptions: {
						noExtensions: true,
						extensionFactories: [piSubagentsExtension],
					},
				});
				return {
					...(await createAgentSessionFromServices({ services, sessionManager: bound })),
					services,
					diagnostics: services.diagnostics,
				};
			},
			{ cwd: workspace, agentDir, sessionManager },
		);
		role = beginControllerRole(
			skillCatalogFromLoaded(runtime.services.resourceLoader.getSkills().skills),
		);
		await runtime.session.bindExtensions({ mode: "print" });
		if (!role.applied) throw new Error("Standalone controller extension did not take ownership");
		if (role.modelId === undefined || role.credential !== "present") {
			throw new StandaloneControllerError(
				"model_unavailable",
				"Standalone controller has no usable Pi model or credential",
				parentSessionId,
			);
		}
		const socketPath = join(directory, `${id}.sock`);
		const manager = await role.manager;
		const ipc = await serveControllerIpc({ socketPath, parentSessionId, manager });
		const started = { runtime, role, lock, ipc };
		role = undefined;
		runtime = undefined;
		return {
			workspace,
			parentSessionId,
			sessionFile,
			socketPath,
			async dispose() {
				await closeControllerIpc(started.ipc);
				await started.runtime.dispose();
				endControllerRole(started.role);
				started.lock.release();
			},
		};
	} catch (error) {
		if (runtime !== undefined) await runtime.dispose();
		if (role !== undefined) endControllerRole(role);
		lock.release();
		throw error;
	}
}

function controllerDirectory(agentDir: string): string {
	return join(agentDir, "subagents", "controllers");
}

function workspaceKey(workspace: string): string {
	return createHash("sha256").update(workspace).digest("hex").slice(0, 32);
}

function lockController(lockPath: string): ProcessLock {
	try {
		return holdProcessLock(lockPath, 0);
	} catch (error) {
		if (isLockBusy(error)) {
			throw new StandaloneControllerError(
				"busy",
				"Standalone controller is already running for this workspace",
			);
		}
		throw error;
	}
}

function isLockBusy(error: unknown): boolean {
	return typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5;
}

function readBinding(path: string): ControllerBinding | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid standalone controller binding: ${path}`, { cause: error });
	}
	if (
		!isRecord(value) ||
		typeof value.workspace !== "string" ||
		typeof value.parentSessionId !== "string" ||
		typeof value.sessionFile !== "string"
	) {
		throw new Error(`Invalid standalone controller binding: ${path}`);
	}
	return {
		workspace: value.workspace,
		parentSessionId: value.parentSessionId,
		sessionFile: value.sessionFile,
	};
}

function writeBinding(path: string, binding: ControllerBinding): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}
