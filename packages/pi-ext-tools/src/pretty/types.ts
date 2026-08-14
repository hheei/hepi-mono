import type { Theme } from "@earendil-works/pi-coding-agent";

export type BundledLanguage = string;

export type FgTheme = Pick<Theme, "fg" | "getFgAnsi">;
