import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createAdvisorMessageComponent } from "../../../src/renderer.js";

describe("Advisor message renderer", () => {
	test("renders dim text on the custom-message background", () => {
		const roles: string[] = [];
		const theme = {
			fg(role: string, text: string) {
				roles.push(`fg:${role}`);
				return `<fg>${text}</fg>`;
			},
			bg(role: string, text: string) {
				roles.push(`bg:${role}`);
				return `<bg>${text}</bg>`;
			},
		} as unknown as Theme;
		const component = createAdvisorMessageComponent(
			[{ severity: "blocker", note: "division uses addition" }],
			theme,
		);

		const lines = component.render(60);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith("<bg> <fg>✦</fg><fg> [advisor blocker] division uses addition");
		expect(lines[0]).toEndWith("</fg> </bg>");
		expect(lines[0]?.replaceAll(/<\/?(?:bg|fg)>/g, "")).toHaveLength(60);
		expect(roles).toEqual(["fg:error", "fg:dim", "bg:customMessageBg"]);
	});

	test("keeps every narrow background row at the requested width", () => {
		const theme = {
			fg: (_role: string, text: string) => text,
			bg: (_role: string, text: string) => text,
		} as unknown as Theme;
		const lines = createAdvisorMessageComponent(
			[{ severity: "concern", note: "a long note that must wrap without losing its band" }],
			theme,
		).render(20);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every((line) => line.length === 20)).toBe(true);
		expect(lines[0]).toStartWith(" ✦ [advisor");
		expect(lines.join(" ")).toContain("concern]");
	});

	test("colors prefixes by severity", () => {
		const roles: string[] = [];
		const theme = {
			fg(role: string, text: string) {
				roles.push(role);
				return text;
			},
			bg: (_role: string, text: string) => text,
		} as unknown as Theme;

		createAdvisorMessageComponent(
			[
				{ severity: "blocker", note: "block" },
				{ severity: "concern", note: "consider" },
				{ severity: "nit", note: "minor" },
			],
			theme,
		).render(80);

		expect(roles).toEqual(["error", "dim", "warning", "dim", "dim", "dim"]);
	});
});
