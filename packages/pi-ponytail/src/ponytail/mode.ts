export const PONYTAIL_INTENSITIES = ["lite", "full", "ultra"] as const;

export type PonytailIntensity = (typeof PONYTAIL_INTENSITIES)[number];
export type PonytailMode = PonytailIntensity | "off";

export const DEFAULT_PONYTAIL_MODE: PonytailIntensity = "full";
export const PONYTAIL_STATE_ENTRY = "pi-ponytail-state";

export type PonytailCommand =
	| { readonly kind: "set"; readonly mode: PonytailMode }
	| { readonly kind: "status" }
	| { readonly kind: "invalid"; readonly value: string };

const INTENSITY_SET: ReadonlySet<string> = new Set(PONYTAIL_INTENSITIES);
const DEACTIVATE_PATTERN = /^(?:stop\s+ponytail|normal\s+mode)[.!?]*$/i;

export function isPonytailIntensity(value: unknown): value is PonytailIntensity {
	return typeof value === "string" && INTENSITY_SET.has(value);
}

export function parsePonytailCommand(args: string): PonytailCommand {
	const value = args.trim().toLowerCase();
	if (value === "") return { kind: "set", mode: DEFAULT_PONYTAIL_MODE };
	if (value === "status") return { kind: "status" };
	if (["off", "normal", "stop", "disable"].includes(value)) {
		return { kind: "set", mode: "off" };
	}
	if (isPonytailIntensity(value)) return { kind: "set", mode: value };
	return { kind: "invalid", value };
}

export function detectPonytailDeactivation(text: string): boolean {
	return DEACTIVATE_PATTERN.test(text.trim());
}

export function restorePonytailMode(
	entries: ReadonlyArray<unknown>,
	fallback: PonytailMode = DEFAULT_PONYTAIL_MODE,
): PonytailMode {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PONYTAIL_STATE_ENTRY) {
			continue;
		}
		const data = entry.data;
		if (!isRecord(data) || data.version !== 1) continue;
		if (data.mode === "off" || isPonytailIntensity(data.mode)) return data.mode;
	}
	return fallback;
}

export function ponytailStatusLabel(mode: PonytailMode): string | undefined {
	if (mode === "off") return undefined;
	return mode === "full" ? "ponytail" : `ponytail:${mode}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}
