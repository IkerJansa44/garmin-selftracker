import { type ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateMockRecords } from "../src/lib/mockData";
import { type CheckInQuestion } from "../src/lib/types";

const api = vi.hoisted(() => ({
  dismissCorrelationNotifications: vi.fn(),
  fetchCheckinReminderSettings: vi.fn(),
  fetchCheckIns: vi.fn(),
  fetchCorrelationValues: vi.fn(),
  fetchDashboardData: vi.fn(),
  fetchDashboardPlotSettings: vi.fn(),
  fetchDerivedPredictors: vi.fn(),
  fetchQuestionSettings: vi.fn(),
  saveCheckIn: vi.fn(),
  saveCheckInDraft: vi.fn(),
  saveCheckinReminderSettings: vi.fn(),
  saveDashboardPlotSettings: vi.fn(),
  saveDerivedPredictors: vi.fn(),
  saveQuestionSettings: vi.fn(),
  startDateRangeImport: vi.fn(),
  startManualImport: vi.fn(),
  startRefreshImport: vi.fn(),
}));

vi.mock("../src/lib/api", () => api);
vi.mock("gsap", () => ({
  gsap: {
    context: (callback: () => void) => {
      callback();
      return { revert: vi.fn() };
    },
    from: vi.fn(),
    registerPlugin: vi.fn(),
    to: vi.fn(),
  },
}));
vi.mock("gsap/ScrollTrigger", () => ({ ScrollTrigger: {} }));
vi.mock("recharts", () => {
  const Chart = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    CartesianGrid: Chart,
    ComposedChart: Chart,
    Line: Chart,
    ReferenceLine: Chart,
    ResponsiveContainer: Chart,
    Scatter: Chart,
    ScatterChart: Chart,
    Tooltip: Chart,
    XAxis: Chart,
    YAxis: Chart,
  };
});

import App from "../src/App";

const JOURNAL_QUESTION: CheckInQuestion = {
  id: "journal",
  section: "General",
  prompt: "Journal",
  inputType: "text",
  analysisMode: "predictor_next_day",
  defaultIncluded: true,
};
const REMINDER_SETTINGS = {
  enabled: false,
  notifyAfter: "21:00",
  emailBody: "Reminder at 21:00",
};
const RECOVERY_PLOT = {
  id: "recovery-plot",
  key: "metric:recoveryIndex",
  direction: "higher" as const,
  aggregation: "daily" as const,
  rolling: false,
  reduceMethod: "mean" as const,
  chartStyle: "line" as const,
};

function setView(view: "checkin" | "dashboard" | "settings") {
  window.history.replaceState(null, "", `/?view=${view}`);
}

function mockInitialLoads({
  drafts = [],
  entries = [],
  plots = [RECOVERY_PLOT],
}: {
  drafts?: Array<{ date: string; answers: Record<string, string>; updatedAt: string }>;
  entries?: Array<{ date: string; answers: Record<string, string>; completedAt: string }>;
  plots?: typeof RECOVERY_PLOT[];
} = {}) {
  api.fetchDashboardData.mockResolvedValue({
    records: generateMockRecords(2),
    importStatus: { state: "ok", lastImportAt: null, message: "Ready", errorDetail: null },
    notifications: { correlations: [] },
    meta: { source: "test", days: 2, availableDays: 2 },
    hrZoneBounds: null,
  });
  api.fetchCheckIns.mockImplementation(
    () => new Promise((resolve) => window.setTimeout(() => resolve({ entries, drafts }), 0)),
  );
  api.fetchCorrelationValues.mockResolvedValue({ values: [] });
  api.fetchQuestionSettings.mockResolvedValue({ questions: [JOURNAL_QUESTION] });
  api.fetchDerivedPredictors.mockResolvedValue({ definitions: [] });
  api.fetchCheckinReminderSettings.mockResolvedValue(REMINDER_SETTINGS);
  api.fetchDashboardPlotSettings.mockImplementation(
    () => new Promise((resolve) => window.setTimeout(() => resolve({ plots }), 0)),
  );
  api.saveCheckInDraft.mockImplementation(async (date, answers) => ({
    draft: { date, answers, updatedAt: `${date}T12:00:00Z` },
  }));
  api.saveCheckinReminderSettings.mockImplementation(async (settings) => settings);
  api.saveDashboardPlotSettings.mockImplementation(async (plots) => ({ plots }));
}

function todayIso() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

describe("App persistence workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockInitialLoads();
  });

  it("saves the actual check-in form and turns its panel green", async () => {
    setView("checkin");
    const user = userEvent.setup();
    const date = todayIso();
    api.saveCheckIn.mockImplementation(async (_date, answers) => ({
      entry: { date, answers, completedAt: `${date}T12:00:00Z` },
    }));

    render(<App />);
    const journal = await screen.findByPlaceholderText("Optional note");
    const panel = screen.getByRole("heading", { name: "Daily Check-In" }).closest("article");
    await user.type(journal, "Good recovery day");
    await user.click(screen.getByRole("button", { name: "Save Check-In" }));

    await screen.findByText(/Saved check-in for/);
    expect(api.saveCheckIn).toHaveBeenCalledWith(
      date,
      expect.objectContaining({ journal: "Good recovery day" }),
    );
    expect(panel).toHaveStyle({ backgroundColor: "#edf5ef" });
  });

  it("keeps answers and the unsaved appearance when saving fails", async () => {
    setView("checkin");
    const user = userEvent.setup();
    api.saveCheckIn.mockRejectedValue(new Error("database unavailable"));

    render(<App />);
    const journal = await screen.findByPlaceholderText("Optional note");
    const panel = screen.getByRole("heading", { name: "Daily Check-In" }).closest("article");
    await user.type(journal, "Keep this answer");
    await user.click(screen.getByRole("button", { name: "Save Check-In" }));

    await screen.findByText(/SQLite sync failed: database unavailable/);
    expect(journal).toHaveValue("Keep this answer");
    expect(panel).not.toHaveStyle({ backgroundColor: "#edf5ef" });
  });

  it("restores a SQLite draft and clears its draft status after final save", async () => {
    setView("checkin");
    const user = userEvent.setup();
    const date = todayIso();
    mockInitialLoads({
      drafts: [{ date, answers: { journal: "Recovered draft" }, updatedAt: `${date}T11:00:00Z` }],
    });
    api.saveCheckIn.mockResolvedValue({
      entry: { date, answers: { journal: "Recovered draft" }, completedAt: `${date}T12:00:00Z` },
    });

    render(<App />);
    const journal = await screen.findByPlaceholderText("Optional note");
    await waitFor(() => expect(journal).toHaveValue("Recovered draft"));
    expect(screen.getByText(/Draft saved to SQLite/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Check-In" }));

    await screen.findByText(/Saved check-in for/);
    expect(screen.queryByText(/Draft saved to SQLite/)).not.toBeInTheDocument();
    expect(api.saveCheckIn).toHaveBeenCalledWith(
      date,
      expect.objectContaining({ journal: "Recovered draft" }),
    );
  });

  it("persists reminder settings after a user change", async () => {
    setView("settings");
    const user = userEvent.setup();

    render(<App />);
    const reminderHeading = await screen.findByRole("heading", { name: "Check-In Reminder" });
    const checkbox = within(reminderHeading.closest("article")!).getByRole("checkbox", {
      name: "Enable email reminder",
    });
    await user.click(checkbox);

    await waitFor(() =>
      expect(api.saveCheckinReminderSettings).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
        expect.any(AbortSignal),
      ),
    );
  });

  it("persists dashboard plot removal", async () => {
    setView("dashboard");
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Plot layout synced with SQLite.");
    await user.click(await screen.findByRole("button", { name: "Remove Recovery Index plot" }));

    await waitFor(() =>
      expect(api.saveDashboardPlotSettings).toHaveBeenCalledWith([], expect.any(AbortSignal)),
    );
  });
});
