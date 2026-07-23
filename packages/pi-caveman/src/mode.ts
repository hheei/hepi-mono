export const CAVEMAN_INTENSITIES = [
	"lite",
	"full",
	"ultra",
	"wenyan-lite",
	"wenyan-full",
	"wenyan-ultra",
] as const;

export type CavemanIntensity = (typeof CAVEMAN_INTENSITIES)[number];
export type CavemanMode = CavemanIntensity | "off";

export const DEFAULT_CAVEMAN_MODE: CavemanIntensity = "full";
export const CAVEMAN_STATE_ENTRY = "pi-caveman-state";

export type CavemanCommand =
	| { readonly kind: "set"; readonly mode: CavemanMode }
	| { readonly kind: "status" }
	| { readonly kind: "invalid"; readonly value: string };

const INTENSITY_SET: ReadonlySet<string> = new Set(CAVEMAN_INTENSITIES);
const NATURAL_INTENSITY = "(?:lite|full|ultra|wenyan(?:-(?:lite|full|ultra))?)";
const ACTIVATE_PATTERN = new RegExp(
	`^(?:(?:activate|enable|start|use|turn\\s+on)\\s+(?:${NATURAL_INTENSITY}\\s+)?(?:the\\s+)?caveman(?:\\s+mode)?(?:\\s+${NATURAL_INTENSITY})?|talk\\s+like\\s+(?:a\\s+)?caveman(?:\\s+mode)?(?:\\s+${NATURAL_INTENSITY})?|caveman\\s+mode)$`,
	"i",
);
const DEACTIVATE_PATTERN =
	/^(?:(?:stop|disable|deactivate|turn\s+off)\s+(?:the\s+)?caveman(?:\s+mode)?|normal\s+mode)$/i;

export function isCavemanIntensity(value: unknown): value is CavemanIntensity {
	return typeof value === "string" && INTENSITY_SET.has(value);
}

export function parseCavemanCommand(args: string): CavemanCommand {
	const value = args.trim().toLowerCase();
	if (value === "") return { kind: "set", mode: DEFAULT_CAVEMAN_MODE };
	if (value === "status") return { kind: "status" };
	if (["off", "normal", "stop", "disable"].includes(value)) {
		return { kind: "set", mode: "off" };
	}
	if (value === "wenyan") return { kind: "set", mode: "wenyan-full" };
	if (isCavemanIntensity(value)) return { kind: "set", mode: value };
	return { kind: "invalid", value };
}

export function detectCavemanIntent(text: string): CavemanMode | undefined {
	const normalized = normalizeIntentText(text);
	if (DEACTIVATE_PATTERN.test(normalized)) return "off";
	if (!ACTIVATE_PATTERN.test(normalized)) return undefined;
	const intensity = normalized.match(
		/\b(wenyan-(?:lite|full|ultra)|wenyan|lite|full|ultra)\b/i,
	)?.[1];
	if (intensity === undefined) return DEFAULT_CAVEMAN_MODE;
	const command = parseCavemanCommand(intensity);
	return command.kind === "set" ? command.mode : DEFAULT_CAVEMAN_MODE;
}

export function restoreCavemanMode(
	entries: ReadonlyArray<unknown>,
	fallback: CavemanMode = DEFAULT_CAVEMAN_MODE,
): CavemanMode {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CAVEMAN_STATE_ENTRY) {
			continue;
		}
		const data = entry.data;
		if (!isRecord(data) || data.version !== 1) continue;
		if (data.mode === "off" || isCavemanIntensity(data.mode)) return data.mode;
	}
	return fallback;
}

export function cavemanStatusLabel(mode: CavemanMode): string | undefined {
	if (mode === "off") return undefined;
	return mode === "full" ? "caveman" : `caveman:${mode}`;
}

function normalizeIntentText(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/^(?:please\s+)/, "")
		.replace(/(?:\s+please|\s+for\s+(?:this|the)\s+session)?[.!]*$/, "")
		.trim();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}
