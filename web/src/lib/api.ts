import {
  type AnalysisValueRecord,
  type CheckInEntry,
  type CheckInDraft,
  type DerivedPredictorDefinition,
  type CheckinReminderSettings,
  type CheckInQuestion,
  type DailyRecord,
  type ImportState,
  type NotificationPreferences,
  type MonthlyReportSettings,
  type MonthlyReportStatus,
} from "./types";

interface ImportStatusSummary {
  state: ImportState;
  lastImportAt: string | null;
  message: string;
  errorDetail: string | null;
}

export interface CorrelationNotification {
  id: string;
  key: string;
  predictor: string;
  outcome: string;
  predictorLabel: string;
  outcomeLabel: string;
  sampleCount: number;
  correlation: number;
  qValue: number;
  createdAt: string;
}

interface DashboardMeta {
  source: string;
  days: number;
  availableDays: number;
}

export interface DashboardApiResponse {
  records: DailyRecord[];
  importStatus: ImportStatusSummary;
  notifications?: {
    correlations?: CorrelationNotification[];
  };
  meta: DashboardMeta;
  hrZoneBounds: number[] | null;
}

export interface QuestionsApiResponse {
  questions: CheckInQuestion[];
}

export interface DerivedPredictorsApiResponse {
  definitions: DerivedPredictorDefinition[];
}

interface CheckInsApiResponse {
  entries: CheckInEntry[];
  drafts: CheckInDraft[];
}

interface CorrelationValuesApiResponse {
  values: AnalysisValueRecord[];
}

interface CheckInSaveApiResponse {
  entry: CheckInEntry;
}

interface CheckInDraftSaveApiResponse {
  draft: CheckInDraft;
}

interface ImportApiResponse {
  status: string;
  mode: "range";
  fromDate: string;
  toDate: string;
  days: number;
}

export type PlotDirection = "higher" | "lower";

export type PlotAggregation = "daily" | "3days" | "weekly";

export type PlotReduceMethod = "mean" | "sum";

export type PlotChartStyle = "line" | "sleepWindowBars";

export interface DashboardPlotPreference {
  id?: string;
  key: string;
  direction: PlotDirection;
  aggregation?: PlotAggregation;
  rolling?: boolean;
  reduceMethod?: PlotReduceMethod;
  chartStyle?: PlotChartStyle;
}

interface DashboardPlotsApiResponse {
  plots: DashboardPlotPreference[];
}

export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

async function readApiError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: string; details?: string };
    const parts = [payload.error, payload.details].filter(Boolean);
    if (parts.length) {
      return new Error(parts.join(": "));
    }
  } catch {
    // Ignore non-JSON errors and return fallback.
  }
  return new Error(fallback);
}

type ApiRequestOptions = Omit<RequestInit, "body"> & { json?: unknown };

async function apiRequest<T>(
  url: string,
  failureMessage: string,
  { json, ...options }: ApiRequestOptions = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    ...(json === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json", ...options.headers },
          body: JSON.stringify(json),
        }),
  });
  if (!response.ok) {
    throw await readApiError(response, `${failureMessage}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchDashboardData(
  days = 365,
  signal?: AbortSignal,
): Promise<DashboardApiResponse> {
  return apiRequest(`/api/dashboard?days=${days}`, "Dashboard API failed", { signal });
}

export async function fetchQuestionSettings(
  signal?: AbortSignal,
): Promise<QuestionsApiResponse> {
  return apiRequest("/api/questions", "Questions API failed", { signal });
}

export async function fetchDashboardPlotSettings(
  signal?: AbortSignal,
): Promise<DashboardPlotsApiResponse> {
  return apiRequest("/api/dashboard-plots", "Dashboard plot settings API failed", { signal });
}

export async function saveDashboardPlotSettings(
  plots: DashboardPlotPreference[],
  signal?: AbortSignal,
): Promise<DashboardPlotsApiResponse> {
  return apiRequest("/api/dashboard-plots", "Saving dashboard plot settings failed", {
    method: "PUT",
    json: { plots },
    signal,
  });
}

export async function saveQuestionSettings(
  questions: CheckInQuestion[],
  signal?: AbortSignal,
): Promise<QuestionsApiResponse> {
  return apiRequest("/api/questions", "Saving questions failed", {
    method: "PUT",
    json: { questions },
    signal,
  });
}

export async function fetchDerivedPredictors(
  signal?: AbortSignal,
): Promise<DerivedPredictorsApiResponse> {
  return apiRequest(
    "/api/correlation/derived-predictors",
    "Derived predictors API failed",
    { signal },
  );
}

export async function saveDerivedPredictors(
  definitions: DerivedPredictorDefinition[],
  signal?: AbortSignal,
): Promise<DerivedPredictorsApiResponse> {
  return apiRequest("/api/correlation/derived-predictors", "Saving derived predictors failed", {
    method: "PUT",
    json: { definitions },
    signal,
  });
}

export async function fetchCheckIns(
  fromDate: string,
  toDate: string,
  signal?: AbortSignal,
): Promise<CheckInsApiResponse> {
  return apiRequest(
    `/api/checkins?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`,
    "Check-ins API failed",
    { signal },
  );
}

export async function fetchCorrelationValues(
  fromDate: string,
  toDate: string,
  signal?: AbortSignal,
): Promise<CorrelationValuesApiResponse> {
  return apiRequest(
    `/api/correlation/values?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`,
    "Correlation values API failed",
    { signal },
  );
}

export async function saveCheckIn(
  date: string,
  answers: Record<string, string | number | boolean>,
  signal?: AbortSignal,
): Promise<CheckInSaveApiResponse> {
  return apiRequest("/api/checkins", "Saving check-in failed", {
    method: "PUT",
    json: { date, answers },
    signal,
  });
}

export async function saveCheckInDraft(
  date: string,
  answers: Record<string, string | number | boolean>,
  signal?: AbortSignal,
): Promise<CheckInDraftSaveApiResponse> {
  return apiRequest("/api/checkin-drafts", "Saving check-in draft failed", {
    method: "PUT",
    json: { date, answers },
    signal,
  });
}

export async function dismissCorrelationNotifications(
  ids: string[],
  signal?: AbortSignal,
): Promise<{ correlations: CorrelationNotification[] }> {
  return apiRequest("/api/notifications/correlations", "Dismissing notifications failed", {
    method: "PUT",
    json: { ids },
    signal,
  });
}

export async function fetchCheckinReminderSettings(
  signal?: AbortSignal,
): Promise<CheckinReminderSettings> {
  return apiRequest("/api/checkin-reminder-settings", "Check-in reminder settings API failed", {
    signal,
  });
}

export async function saveCheckinReminderSettings(
  settings: CheckinReminderSettings,
  signal?: AbortSignal,
): Promise<CheckinReminderSettings> {
  return apiRequest("/api/checkin-reminder-settings", "Saving check-in reminder settings failed", {
    method: "PUT",
    json: settings,
    signal,
  });
}

export async function fetchWebPushPublicKey(
  signal?: AbortSignal,
): Promise<{ publicKey: string }> {
  return apiRequest("/api/push/public-key", "Web Push configuration API failed", { signal });
}

export async function fetchNotificationPreferences(
  signal?: AbortSignal,
): Promise<NotificationPreferences> {
  return apiRequest("/api/notification-preferences", "Notification preferences API failed", {
    signal,
  });
}

export async function saveNotificationPreferences(
  preferences: NotificationPreferences,
  signal?: AbortSignal,
): Promise<NotificationPreferences> {
  return apiRequest("/api/notification-preferences", "Saving notification preferences failed", {
    method: "PUT",
    json: preferences,
    signal,
  });
}

export async function savePushSubscription(
  subscription: PushSubscriptionPayload,
  signal?: AbortSignal,
): Promise<{ subscribed: true; created: boolean }> {
  return apiRequest("/api/push/subscriptions", "Saving push subscription failed", {
    method: "POST",
    json: subscription,
    signal,
  });
}

export async function deletePushSubscription(
  endpoint: string,
  signal?: AbortSignal,
): Promise<{ subscribed: false; removed: boolean }> {
  return apiRequest("/api/push/subscriptions", "Deleting push subscription failed", {
    method: "DELETE",
    json: { endpoint },
    signal,
  });
}

export async function startDateRangeImport(
  fromDate: string,
  toDate: string,
  signal?: AbortSignal,
): Promise<ImportApiResponse> {
  return apiRequest("/api/import", "Date range import failed", {
    method: "POST",
    json: { mode: "range", fromDate, toDate },
    signal,
  });
}

export async function fetchMonthlyReportSettings(signal?: AbortSignal): Promise<MonthlyReportSettings> {
  return apiRequest("/api/monthly-report-settings", "Monthly report settings API failed", { signal });
}

export async function saveMonthlyReportSettings(
  settings: MonthlyReportSettings,
  signal?: AbortSignal,
): Promise<MonthlyReportSettings> {
  return apiRequest("/api/monthly-report-settings", "Saving monthly report settings failed", {
    method: "PUT",
    json: settings,
    signal,
  });
}

export async function fetchMonthlyReportStatus(signal?: AbortSignal): Promise<MonthlyReportStatus> {
  return apiRequest("/api/monthly-reports/status", "Monthly report status API failed", { signal });
}

export async function generateMonthlyReport(
  month: string,
  sendEmail: boolean,
  signal?: AbortSignal,
): Promise<{ status: string; month: string; sendEmail: boolean }> {
  return apiRequest("/api/monthly-reports/generate", "Monthly report generation failed", {
    method: "POST",
    json: { month, sendEmail },
    signal,
  });
}
