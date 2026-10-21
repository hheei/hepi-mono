import { loadConfig } from "./utils.ts";

type FeatureConfig = { image?: { enabled?: unknown } };

function loadFeatureConfig(): FeatureConfig {
	const raw = loadConfig() as unknown as FeatureConfig;
	return raw && typeof raw === "object" ? raw : {};
}

export function isImageEnabled(): boolean {
	return loadFeatureConfig().image?.enabled !== false;
}

export function canAttachImages(): boolean {
	try {
		return isImageEnabled();
	} catch {
		return false;
	}
}
