import { type DailyRecord, type ImportState } from "./types";

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
