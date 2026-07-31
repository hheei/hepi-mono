import { getGlobalState } from "./global-state.js";
import { type RuntimeHost, runtimeIdentity } from "./runtime-identity.js";

interface SkillState {
	disabled: ReadonlySet<string>;
}

function states(): WeakMap<object, SkillState> {
	return getGlobalState("disabled-skill-state", () => new WeakMap());
}

function canonicalSkillKey(name: string): string {
	const bareName = name.startsWith("skill:") ? name.slice("skill:".length) : name;
	if (!bareName.trim()) throw new Error("Skill name must not be empty");
	return `skill:${bareName}`;
}

/** Publishes the current disabled skill set; the caller owns policy and cleanup. */
export function setDisabledSkillKeys(pi: RuntimeHost, names: Iterable<string>): void {
	const disabled = new Set<string>();
	for (const name of names) disabled.add(canonicalSkillKey(name));
	states().set(runtimeIdentity(pi), { disabled });
}

/** Clears a consumer's runtime-scoped disabled skill publication. */
export function clearDisabledSkillKeys(pi: RuntimeHost): void {
	states().delete(runtimeIdentity(pi));
}

/** Returns a stable snapshot so consumers cannot mutate the publisher's state. */
export function getDisabledSkillKeys(pi: RuntimeHost): ReadonlySet<string> {
	return states().get(runtimeIdentity(pi))?.disabled ?? new Set();
}

/** Checks a bare skill name or canonical `skill:<name>` against the runtime state. */
export function isSkillEnabled(pi: RuntimeHost, name: string): boolean {
	return !getDisabledSkillKeys(pi).has(canonicalSkillKey(name));
}
