import { expect, test } from "bun:test";
import {
	joinStatusbarFormat,
	parseStatusbarFormat,
	renderStatusbarFormat,
} from "../../../src/contributions/statusbar/format.js";

test("tokenizes the format before injecting opaque variable values", () => {
	const rendered = renderStatusbarFormat(parseStatusbarFormat("$prefix$fill$title"), {
		prefix: "left",
		thinking: "",
		model: "",
		context: "",
		statuses: "",
		title: "$prefix$fill",
	});
	expect(joinStatusbarFormat(rendered.beforeFill)).toBe("left");
	expect(joinStatusbarFormat(rendered.afterFill)).toBe("$prefix$fill");
});

test("rejects a format variable without a Pi Basics module", () => {
	expect(() => parseStatusbarFormat("$unknown")).toThrow(
		"Unknown statusbar format variable: unknown",
	);
});
