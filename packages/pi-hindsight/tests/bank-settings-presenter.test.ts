import { describe, expect, it } from "vitest";
import {
  bankConfigOverrideSummaryLines,
  bankSettingsTargetDisplay,
  bankSettingsTargetLines,
} from "../extensions/banks/bank-settings-presenter.js";

describe("bank settings presenter", () => {
  it("shows concrete location and bank IDs", () => {
    expect(bankSettingsTargetDisplay({ location: "Project", bankId: "project-bank" })).toEqual({
      location: "Project",
      bankId: "project-bank",
      locationLabel: "Location: Project",
      bankLabel: "Bank: project-bank",
      optionLabel: "Project bank (project-bank)",
      reviewLine: "Project → Bank: project-bank",
    });
    expect(bankSettingsTargetLines({ location: "User", bankId: "user-bank" })).toEqual([
      "Location: User",
      "Bank: user-bank",
    ]);
  });

  it("summarizes resolved config responses", () => {
    expect(
      bankConfigOverrideSummaryLines({
        config: { retain_mission: "resolved", reflect_mission: "resolved" },
        overrides: { retain_mission: "override" },
      }),
    ).toEqual(["Bank overrides: 1", "Resolved config fields: 2"]);
  });
});
