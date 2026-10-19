import type { Theme } from "@earendil-works/pi-coding-agent";

/** A theme that adds no styling, so a rendered row can be asserted as plain text. */
export const plainTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (_role: string, text: string): string => text,
	bold: (text: string): string => text,
} as Theme;

/** A theme that tags foreground roles, so assertions can see which role styled what. */
export const roleTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
	bold: (text: string): string => text,
} as Theme;

/** A theme that tags every role, for rows asserted as exact markup. */
export const taggedTheme = {
	bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
	fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
	bold: (text: string): string => `<b>${text}</b>`,
} as Theme;
