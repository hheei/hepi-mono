import { isRecord } from "../config/config-normalize.js";

export type BankSettingsLocation = "Project" | "User";

export interface BankSettingsTarget {
  location: BankSettingsLocation;
  bankId: string;
}

export interface BankSettingsTargetDisplay {
  location: BankSettingsLocation;
  bankId: string;
  locationLabel: string;
  bankLabel: string;
  optionLabel: string;
  reviewLine: string;
}

export function bankSettingsTargetDisplay(target: BankSettingsTarget): BankSettingsTargetDisplay {
  return {
    location: target.location,
    bankId: target.bankId,
    locationLabel: `Location: ${target.location}`,
    bankLabel: `Bank: ${target.bankId}`,
    optionLabel: `${target.location} bank (${target.bankId})`,
    reviewLine: `${target.location} → Bank: ${target.bankId}`,
  };
}

export function bankSettingsTargetLines(target: BankSettingsTarget): string[] {
  const display = bankSettingsTargetDisplay(target);
  return [display.locationLabel, display.bankLabel];
}

function objectCount(value: unknown): number {
  return isRecord(value) ? Object.keys(value).length : 0;
}

export function bankConfigOverrideSummaryLines(response: unknown): string[] {
  if (!isRecord(response)) return ["Bank overrides: unavailable"];
  const overrides = isRecord(response.overrides) ? response.overrides : undefined;
  const config = isRecord(response.config) ? response.config : undefined;
  const overrideCount = objectCount(overrides);
  const resolvedCount = objectCount(config);
  return [`Bank overrides: ${overrideCount}`, `Resolved config fields: ${resolvedCount}`];
}
