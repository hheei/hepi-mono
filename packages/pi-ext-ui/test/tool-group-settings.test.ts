import { expect, test } from "vitest";
import { activityGroupsEnabled } from "../src/settings.js";

test("activity groups stay on unless settings explicitly disable them", () => {
	expect(activityGroupsEnabled(undefined)).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: {} })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: "false" } })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: true } })).toBe(true);
	expect(activityGroupsEnabled({ toolGroups: { enabled: false } })).toBe(false);
});
