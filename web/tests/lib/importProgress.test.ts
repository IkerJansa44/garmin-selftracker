import { describe, expect, it } from "vitest";

import {
  buildImportProgressDisplay,
  parseImportProgressMessage,
} from "../../src/lib/importProgress";

describe("parseImportProgressMessage", () => {
  it("extracts completed days, total days, and ETA", () => {
    expect(parseImportProgressMessage("Import in progress · 2/4 days · ~20 min left")).toEqual({
      completedDays: 2,
      totalDays: 4,
      etaLabel: "~20 min left",
    });
  });
});

describe("buildImportProgressDisplay", () => {
  it("shows running progress even when the import range was not started in this browser session", () => {
    const display = buildImportProgressDisplay(
      {
        state: "running",
        message: "Import in progress · 2/4 days · ~20 min left",
      },
      null,
    );

    expect(display).toEqual({
      progress: {
        completedDays: 2,
        totalDays: 4,
        etaLabel: "~20 min left",
      },
      percent: 50,
      title: "Import in progress ETA ~20 min left",
    });
  });
});
