import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type LoadoutState = { enabledSkills?: unknown };
type BranchEntry = { type?: string; customType?: string; data?: unknown };

const LOADOUT_STATE_CUSTOM_TYPE = "pi-loadout:selection";

function parseLoadoutActiveSkillNames(value: unknown): Set<string> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const enabledSkills = (value as LoadoutState).enabledSkills;
	if (!Array.isArray(enabledSkills)) return undefined;
	return new Set(enabledSkills.filter((name) => typeof name === "string"));
}

export function loadoutActiveSkillNames(ctx: ExtensionContext): Set<string> | undefined {
	const getBranch = ctx?.sessionManager?.getBranch;
	if (typeof getBranch !== "function") return undefined;

	let entries: unknown;
	try {
		entries = getBranch.call(ctx.sessionManager);
	} catch {
		return undefined;
	}

	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as BranchEntry | undefined;
		if (entry?.type !== "custom" || entry.customType !== LOADOUT_STATE_CUSTOM_TYPE) continue;
		return parseLoadoutActiveSkillNames(entry.data);
	}

	return undefined;
}
