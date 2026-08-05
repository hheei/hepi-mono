import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "../types.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { envBool, isRecord, merge, normalizeConfig, validEnvVarName } from "./config-normalize.js";

export { DEFAULT_CONFIG } from "./config-defaults.js";
export { normalizeConfig, validEnvVarName } from "./config-normalize.js";

export const HINDSIGHT_SETTINGS_SECTION = "pi-hindsight";

function readSettingsSection(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  const section = parsed[HINDSIGHT_SETTINGS_SECTION];
  if (section === undefined) return undefined;
  if (!isRecord(section)) throw new Error(`${HINDSIGHT_SETTINGS_SECTION} in ${path} must be an object`);
  return section;
}

export function readGlobalSettingsConfig(home = process.env.HOME): Record<string, unknown> {
  if (!home) return {};
  const settings = readSettingsSection(join(home, ".pi", "agent", "settings.json"));
  return settings ?? {};
}

export function readProjectSettingsConfig(cwd: string): Record<string, unknown> {
  const settings = readSettingsSection(join(cwd, ".pi", "settings.json"));
  return settings ?? {};
}

export function resolveConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  let rawConfig: Record<string, unknown> = {};
  let config = DEFAULT_CONFIG;
  const homeConfig = readGlobalSettingsConfig(env.HOME);
  rawConfig = merge(rawConfig, homeConfig);
  config = merge(config, homeConfig);
  const projectConfig = readProjectSettingsConfig(cwd);
  rawConfig = merge(rawConfig, projectConfig);
  config = merge(config, projectConfig);

  const enabled = envBool(env, "PI_HINDSIGHT_ENABLED");
  if (enabled !== undefined) {
    rawConfig = merge(rawConfig, { enabled });
    config = merge(config, { enabled });
  }
  if (env.HINDSIGHT_BASE_URL) {
    rawConfig = merge(rawConfig, { hindsight: { baseUrl: env.HINDSIGHT_BASE_URL } });
    config = merge(config, { hindsight: { baseUrl: env.HINDSIGHT_BASE_URL } });
  }
  if (env.HINDSIGHT_API_KEY_REF && validEnvVarName(env.HINDSIGHT_API_KEY_REF)) {
    const ref = { source: "env", name: env.HINDSIGHT_API_KEY_REF };
    rawConfig = merge(rawConfig, { hindsight: { apiKey: ref } });
    config = merge(config, { hindsight: { apiKey: ref } });
  }
  // Prefer HINDSIGHT_API_TOKEN; keep HINDSIGHT_API_KEY as legacy fallback.
  const apiKeyFromEnv = env.HINDSIGHT_API_TOKEN?.trim() || env.HINDSIGHT_API_KEY?.trim();
  if (apiKeyFromEnv) {
    rawConfig = merge(rawConfig, { hindsight: { apiKey: apiKeyFromEnv } });
    config = merge(config, { hindsight: { apiKey: apiKeyFromEnv } });
  }
  if (env.PI_HINDSIGHT_PROJECT_BANK_ID) {
    const patch = {
      banks: { project: { bankId: env.PI_HINDSIGHT_PROJECT_BANK_ID, derive: "manual" } },
    };
    rawConfig = merge(rawConfig, patch);
    config = merge(config, patch);
  }
  const userBankId = env.PI_HINDSIGHT_USER_BANK_ID || env.PI_HINDSIGHT_GLOBAL_BANK_ID;
  if (userBankId) {
    const patch = {
      banks: { user: { enabled: true, bankId: userBankId } },
    };
    rawConfig = merge(rawConfig, patch);
    config = merge(config, patch);
  }
  const minScores: Record<string, number> = {};
  const semanticFloor =
    env.PI_HINDSIGHT_MIN_SEMANTIC?.trim() === ""
      ? Number.NaN
      : Number(env.PI_HINDSIGHT_MIN_SEMANTIC);
  if (Number.isFinite(semanticFloor)) minScores.semantic = semanticFloor;
  const rerankerFloor =
    env.PI_HINDSIGHT_MIN_RERANKER?.trim() === ""
      ? Number.NaN
      : Number(env.PI_HINDSIGHT_MIN_RERANKER);
  if (Number.isFinite(rerankerFloor)) minScores.reranker = rerankerFloor;
  if (Object.keys(minScores).length) {
    const patch = { recall: { minScores } };
    rawConfig = merge(rawConfig, patch);
    config = merge(config, patch);
  }
  return normalizeConfig(config, rawConfig, env);
}
