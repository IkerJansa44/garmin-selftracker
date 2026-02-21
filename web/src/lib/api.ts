import {
  type CheckInEntry,
  type DerivedPredictorDefinition,
  type CheckInQuestion,
  type DailyRecord,
  type ImportState,
} from "./types";

interface ImportStatusSummary {
  state: ImportState;
  lastImportAt: string | null;
  message: string;
}

interface DashboardMeta {
  source: string;
  days: number;
  availableDays: number;
}

export interface DashboardApiResponse {
  records: DailyRecord[];
  importStatus: ImportStatusSummary;
  meta: DashboardMeta;
}

export interface QuestionsApiResponse {
  questions: CheckInQuestion[];
}

export interface DerivedPredictorsApiResponse {
  definitions: DerivedPredictorDefinition[];
}

interface CheckInsApiResponse {
  entries: CheckInEntry[];
}

interface CheckInSaveApiResponse {
  entry: CheckInEntry;
}

interface ImportApiResponse {
  status: string;
  mode: "refresh" | "range";
  fromDate: string;
  toDate: string;
  days: number;
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

export async function fetchDashboardData(
  days = 365,
  signal?: AbortSignal,
): Promise<DashboardApiResponse> {
  const response = await fetch(`/api/dashboard?days=${days}`, { signal });
  if (!response.ok) {
    throw new Error(`Dashboard API failed: ${response.status}`);
  }
  return (await response.json()) as DashboardApiResponse;
}

export async function fetchQuestionSettings(
  signal?: AbortSignal,
): Promise<QuestionsApiResponse> {
  const response = await fetch("/api/questions", { signal });
  if (!response.ok) {
    throw new Error(`Questions API failed: ${response.status}`);
  }
  return (await response.json()) as QuestionsApiResponse;
}

export async function saveQuestionSettings(
  questions: CheckInQuestion[],
  signal?: AbortSignal,
): Promise<QuestionsApiResponse> {
  const response = await fetch("/api/questions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Saving questions failed: ${response.status}`);
  }
  return (await response.json()) as QuestionsApiResponse;
}

export async function fetchDerivedPredictors(
  signal?: AbortSignal,
): Promise<DerivedPredictorsApiResponse> {
  const response = await fetch("/api/correlation/derived-predictors", { signal });
  if (!response.ok) {
    throw new Error(`Derived predictors API failed: ${response.status}`);
  }
  return (await response.json()) as DerivedPredictorsApiResponse;
}

export async function saveDerivedPredictors(
  definitions: DerivedPredictorDefinition[],
  signal?: AbortSignal,
): Promise<DerivedPredictorsApiResponse> {
  const response = await fetch("/api/correlation/derived-predictors", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ definitions }),
    signal,
  });
  if (!response.ok) {
    throw await readApiError(response, `Saving derived predictors failed: ${response.status}`);
  }
  return (await response.json()) as DerivedPredictorsApiResponse;
}

export async function fetchCheckIns(
  fromDate: string,
  toDate: string,
  signal?: AbortSignal,
): Promise<CheckInsApiResponse> {
  const response = await fetch(
    `/api/checkins?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`Check-ins API failed: ${response.status}`);
  }
  return (await response.json()) as CheckInsApiResponse;
}

export async function saveCheckIn(
  date: string,
  answers: Record<string, string | number | boolean>,
  signal?: AbortSignal,
): Promise<CheckInSaveApiResponse> {
  const response = await fetch("/api/checkins", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, answers }),
    signal,
  });
  if (!response.ok) {
    throw await readApiError(response, `Saving check-in failed: ${response.status}`);
  }
  return (await response.json()) as CheckInSaveApiResponse;
}

export async function startRefreshImport(signal?: AbortSignal): Promise<ImportApiResponse> {
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "refresh" }),
    signal,
  });
  if (!response.ok) {
    throw await readApiError(response, `Import refresh failed: ${response.status}`);
  }
  return (await response.json()) as ImportApiResponse;
}

export async function startDateRangeImport(
  fromDate: string,
  toDate: string,
  signal?: AbortSignal,
): Promise<ImportApiResponse> {
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "range", fromDate, toDate }),
    signal,
  });
  if (!response.ok) {
    throw await readApiError(response, `Date range import failed: ${response.status}`);
  }
  return (await response.json()) as ImportApiResponse;
}
