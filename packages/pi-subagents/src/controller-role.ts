import type { SkillCatalogEntry } from "./agent-resolver.js";
import type { DashboardView, DelegationView } from "./delegation.js";
import type { DelegateSubagentInput, OperationError, PublicSubagent } from "./domain.js";
import type { ParentChannel } from "./manager.js";

export interface ControllerManager {
	delegate(
		input: DelegateSubagentInput & { readonly wait?: boolean },
		signal?: AbortSignal,
	): Promise<DelegationView | OperationError>;
	inspect(input: {
		readonly id: string;
		readonly revision?: number;
		readonly includeOutput?: boolean;
	}): Promise<DelegationView | OperationError>;
	dashboard(): Promise<DashboardView>;
	stopAgent(id: string): Promise<DelegationView | OperationError>;
	get(id: string): Promise<PublicSubagent | OperationError>;
	list(): Promise<readonly PublicSubagent[]>;
	stop(id: string): Promise<PublicSubagent | OperationError>;
	getEntries(
		id: string,
		range?: { readonly cursor?: number; readonly limit?: number },
	): Promise<{ readonly entries: readonly unknown[]; readonly nextCursor?: number } | undefined>;
}

/** In-process ownership for one standalone controller. Print mode is not this signal. */
export interface ControllerRole extends ParentChannel {
	readonly skills: readonly SkillCatalogEntry[];
	applied: boolean;
	modelId?: string;
	provider?: string;
	credential: "present" | "missing";
	readonly manager: Promise<ControllerManager>;
	bindManager(manager: ControllerManager): void;
	dispose(): void;
}

let current: ControllerRole | undefined;

export function beginControllerRole(skills: readonly SkillCatalogEntry[]): ControllerRole {
	if (current !== undefined) throw new Error("Standalone controller role is already active");
	let closed = false;
	let resolveManager: ((manager: ControllerManager) => void) | undefined;
	const manager = new Promise<ControllerManager>((resolve) => {
		resolveManager = resolve;
	});
	const role: ControllerRole = {
		skills,
		applied: false,
		credential: "missing",
		manager,
		bindManager(value) {
			resolveManager?.(value);
		},
		deliver() {
			if (closed) return Promise.reject(new Error("Standalone controller report sink is closed"));
			return Promise.resolve();
		},
		dispose() {
			closed = true;
		},
	};
	current = role;
	return role;
}

export function activeControllerRole(): ControllerRole | undefined {
	return current;
}

export function endControllerRole(role: ControllerRole): void {
	role.dispose();
	if (current === role) current = undefined;
}
