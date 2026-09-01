import { type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateMockRecords } from "../src/lib/mockData";
import { type CheckInQuestion } from "../src/lib/types";

const api = vi.hoisted(() => ({
  deletePushSubscription: vi.fn(),
  dismissCorrelationNotifications: vi.fn(),
  fetchCheckinReminderSettings: vi.fn(),
  fetchCheckIns: vi.fn(),
  fetchCorrelationValues: vi.fn(),
  fetchDashboardData: vi.fn(),
  fetchDashboardPlotSettings: vi.fn(),
  fetchDerivedPredictors: vi.fn(),
  fetchNotificationPreferences: vi.fn(),
  fetchQuestionSettings: vi.fn(),
  fetchWebPushPublicKey: vi.fn(),
  saveCheckIn: vi.fn(),
  saveCheckInDraft: vi.fn(),
  saveCheckinReminderSettings: vi.fn(),
  saveDashboardPlotSettings: vi.fn(),
  saveDerivedPredictors: vi.fn(),
  saveNotificationPreferences: vi.fn(),
  saveQuestionSettings: vi.fn(),
  savePushSubscription: vi.fn(),
  startDateRangeImport: vi.fn(),
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

function setView(view: "checkin" | "dashboard" | "lab" | "settings") {
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
  api.fetchNotificationPreferences.mockResolvedValue({ email: true, iphone: false });
  api.fetchCheckinReminderSettings.mockResolvedValue(REMINDER_SETTINGS);
  api.fetchDashboardPlotSettings.mockImplementation(
    () => new Promise((resolve) => window.setTimeout(() => resolve({ plots }), 0)),
  );
  api.saveCheckInDraft.mockImplementation(async (date, answers) => ({
    draft: { date, answers, updatedAt: `${date}T12:00:00Z` },
  }));
  api.saveCheckinReminderSettings.mockImplementation(async (settings) => settings);
  api.saveDashboardPlotSettings.mockImplementation(async (plots) => ({ plots }));
  api.saveNotificationPreferences.mockImplementation(async (preferences) => preferences);
  api.saveQuestionSettings.mockImplementation(async (questions) => ({ questions }));
}

function todayIso() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + days);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

describe("App persistence workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockInitialLoads();
  });

  it("opens one import flow with the current two-day range selected", async () => {
    const user = userEvent.setup();
    const today = todayIso();
    const yesterday = shiftIsoDate(today, -1);
    api.startDateRangeImport.mockResolvedValue({
      status: "accepted",
      mode: "range",
      fromDate: yesterday,
      toDate: today,
      days: 2,
    });

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Import" }));

    expect(screen.getByRole("heading", { name: "Import Garmin Data" })).toBeInTheDocument();
    expect(screen.getByLabelText("From date")).toHaveValue(yesterday);
    expect(screen.getByLabelText("To date")).toHaveValue(today);
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /files/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start import" }));
    expect(api.startDateRangeImport).toHaveBeenCalledWith(yesterday, today);
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
      name: "Enable Check-In reminder",
    });
    expect(screen.queryByText("Email text")).not.toBeInTheDocument();
    await user.click(checkbox);

    await waitFor(() =>
      expect(api.saveCheckinReminderSettings).toHaveBeenCalledWith(
        { enabled: true, notifyAfter: "21:00" },
        expect.any(AbortSignal),
      ),
    );
  });

  it("persists question deletion immediately", async () => {
    setView("settings");
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Journal/ }));
    await user.click(screen.getByRole("button", { name: "Delete question" }));

    await waitFor(() => expect(api.saveQuestionSettings).toHaveBeenCalledOnce());
    const savedQuestions = api.saveQuestionSettings.mock.calls[0][0] as CheckInQuestion[];
    expect(savedQuestions.some((question) => question.id === JOURNAL_QUESTION.id)).toBe(false);
  });

  it("keeps an intentionally empty question library empty", async () => {
    setView("settings");
    api.fetchQuestionSettings.mockResolvedValue({ questions: [], configured: true });

    render(<App />);
    const heading = await screen.findByRole("heading", { name: "Asked Questions" });
    const questionPanel = within(heading.closest("article")!);

    await waitFor(() => expect(questionPanel.getAllByRole("button")).toHaveLength(1));
    expect(questionPanel.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("persists moving a question to another section immediately", async () => {
    setView("settings");
    const user = userEvent.setup();
    api.fetchQuestionSettings.mockResolvedValue({
      questions: [
        JOURNAL_QUESTION,
        { ...JOURNAL_QUESTION, id: "stress", prompt: "Stress", section: "Stress & Mind" },
      ],
    });

    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Journal/ }));
    await user.selectOptions(screen.getAllByRole("combobox")[0], "Stress & Mind");

    await waitFor(() => expect(api.saveQuestionSettings).toHaveBeenCalledOnce());
    const savedQuestions = api.saveQuestionSettings.mock.calls[0][0] as CheckInQuestion[];
    expect(savedQuestions.find((question) => question.id === JOURNAL_QUESTION.id)?.section).toBe(
      "Stress & Mind",
    );
  });

  it("moves through the primary tabs with horizontal swipes", async () => {
    setView("dashboard");
    render(<App />);
    const main = screen.getByRole("main");

    const swipe = (fromX: number, toX: number, fromY = 200, toY = 205) => {
      fireEvent.touchStart(main, { touches: [{ clientX: fromX, clientY: fromY }] });
      fireEvent.touchEnd(main, { changedTouches: [{ clientX: toX, clientY: toY }] });
    };
    const expectActive = async (name: string) => {
      await waitFor(() =>
        expect(screen.getByRole("button", { name })).toHaveClass("bg-accent"),
      );
    };

    swipe(300, 180);
    await expectActive("Correlation");
    swipe(300, 180);
    await expectActive("Check-In");
    swipe(300, 180);
    await expectActive("Settings");
    swipe(300, 180);
    await expectActive("Settings");
    swipe(180, 300);
    await expectActive("Check-In");
  });

  it("does not change tabs for a mostly vertical gesture", async () => {
    setView("dashboard");
    render(<App />);
    const main = screen.getByRole("main");

    fireEvent.touchStart(main, { touches: [{ clientX: 220, clientY: 300 }] });
    fireEvent.touchEnd(main, { changedTouches: [{ clientX: 140, clientY: 120 }] });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dashboard" })).toHaveClass("bg-accent"),
    );
  });

  it("keeps a Check-In card swipe within date navigation", async () => {
    setView("checkin");
    render(<App />);
    const panel = await screen.findByRole("article", { name: "Daily Check-In" });
    const dateInput = within(panel).getByDisplayValue(todayIso());
    const previousDate = new Date();
    previousDate.setDate(previousDate.getDate() - 1);
    const previousDateIso = new Date(
      previousDate.getTime() - previousDate.getTimezoneOffset() * 60_000,
    ).toISOString().slice(0, 10);
    Object.defineProperty(panel, "setPointerCapture", { value: vi.fn() });

    fireEvent.touchStart(panel, { touches: [{ clientX: 120, clientY: 200 }] });
    fireEvent.pointerDown(panel, {
      clientX: 120,
      clientY: 200,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerUp(panel, {
      clientX: 220,
      clientY: 205,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.touchEnd(panel, { changedTouches: [{ clientX: 220, clientY: 205 }] });

    await waitFor(() => expect(dateInput).toHaveValue(previousDateIso));
    expect(screen.getByRole("button", { name: "Check-In" })).toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: "Correlation" })).not.toHaveClass("bg-accent");
  });

  it("uses an iOS-style lateral transition when swiping between tabs", async () => {
    setView("dashboard");
    render(<App />);
    const main = screen.getByRole("main");
    const animate = vi.fn(() => ({
      cancel: vi.fn(),
      finished: Promise.resolve(),
    }) as unknown as Animation);
    Object.defineProperty(main, "animate", { configurable: true, value: animate });

    fireEvent.touchStart(main, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchEnd(main, { changedTouches: [{ clientX: 180, clientY: 205 }] });

    await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
    expect(animate.mock.calls[0][0]).toEqual([
      { transform: "translate3d(0px, 0, 0)", opacity: 1 },
      { transform: "translate3d(-96px, 0, 0)", opacity: 0.76 },
    ]);
    expect(animate.mock.calls[1][0]).toEqual([
      { transform: "translate3d(96px, 0, 0)", opacity: 0.76 },
      { transform: "translate3d(0, 0, 0)", opacity: 1 },
    ]);
    expect(screen.getByRole("button", { name: "Correlation" })).toHaveClass("bg-accent");
  });

  it("adds edge resistance when dragging past the first tab", () => {
    setView("dashboard");
    render(<App />);
    const main = screen.getByRole("main");

    fireEvent.touchStart(main, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(main, { touches: [{ clientX: 300, clientY: 204 }] });

    expect(main).toHaveStyle({ transform: "translate3d(48px, 0, 0)" });
  });

  it("uses the compact two-column dashboard plot layout", async () => {
    setView("dashboard");
    render(<App />);

    const search = await screen.findByPlaceholderText("Search metrics and plots");
    await waitFor(() =>
      expect(screen.queryByText("Loading plot layout...")).not.toBeInTheDocument(),
    );
    const plot = (await screen.findByRole("button", {
      name: "Remove Recovery Index plot",
    })).closest("article");

    expect(search).toHaveClass("border", "border-[rgba(18,18,18,0.4)]");
    expect(plot?.parentElement).toHaveClass("grid-cols-2");
    expect(screen.queryByText(/Higher is better for Recovery Index/)).not.toBeInTheDocument();
    expect(screen.queryByText("Plot layout synced with SQLite.")).not.toBeInTheDocument();
  });

  it("uses the compact two-column correlation card layout", async () => {
    setView("lab");
    const records = generateMockRecords(90);
    api.fetchCorrelationValues.mockResolvedValue({
      values: records.slice(1).flatMap((record, index) => [
        {
          analysisDate: record.date,
          role: "predictor" as const,
          featureKey: "garmin:steps",
          valueNum: index * 1_000,
          valueText: null,
          valueBool: null,
          sourceDate: records[index].date,
          lagDays: -1,
          alignmentRule: "garmin_previous_day",
        },
        {
          analysisDate: record.date,
          role: "target" as const,
          featureKey: "metric:restingHr",
          valueNum: 46 + index,
          valueText: null,
          valueBool: null,
          sourceDate: record.date,
          lagDays: 0,
          alignmentRule: "metric_same_day",
        },
      ]),
    });
    api.fetchDashboardData.mockResolvedValue({
      records,
      importStatus: { state: "ok", lastImportAt: null, message: "Ready", errorDetail: null },
      notifications: { correlations: [] },
      meta: { source: "test", days: 90, availableDays: 90 },
      hrZoneBounds: null,
    });

    render(<App />);
    const badge = (await screen.findAllByText(/^(Meaningful|Exploratory)$/, {
      selector: "span",
    }))[0];
    const card = badge.closest("button");

    expect(card).toHaveClass("rounded-[18px]", "p-3");
    expect(card?.parentElement).toHaveClass("grid-cols-2");
  });

  it("offers strength volume, sets, and reps as dashboard plots", async () => {
    setView("dashboard");
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add plot" }));

    expect(screen.getByRole("button", { name: "Strength Volume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Strength Sets" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Strength Reps" })).toBeInTheDocument();
  });

  it("offers HR-to-Speed Ratio as a lower-is-better dashboard plot", async () => {
    setView("dashboard");
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add plot" }));
    await user.click(screen.getByRole("button", { name: "HR-to-Speed Ratio" }));

    expect(screen.getByText("HR-to-Speed Ratio")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lower better" }));
    expect(screen.getByText("How should data be aggregated?")).toBeInTheDocument();
  });

  it("maps the internal sleep consistency key to the sleep timing variability UI name", async () => {
    setView("dashboard");
    mockInitialLoads({
      plots: [{
        ...RECOVERY_PLOT,
        id: "sleep-timing-variability-plot",
        key: "garmin:sleepConsistency",
        direction: "lower",
      }],
    });
    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Remove Sleep Timing Variability plot",
    })).toBeInTheDocument();
    expect(screen.queryByText("Sleep Consistency")).not.toBeInTheDocument();
  });

  it("persists dashboard plot removal", async () => {
    setView("dashboard");
    const user = userEvent.setup();

    render(<App />);
    await waitFor(() =>
      expect(screen.queryByText("Loading plot layout...")).not.toBeInTheDocument(),
    );
    await user.click(await screen.findByRole("button", { name: "Remove Recovery Index plot" }));

    await waitFor(() =>
      expect(api.saveDashboardPlotSettings).toHaveBeenCalledWith([], expect.any(AbortSignal)),
    );
  });
});
