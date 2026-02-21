import { type CheckInQuestion, type DailyRecord, type ImportState } from "./types";

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
