import { type ImportState } from "./types";

export interface ImportRange {
  fromDate: string;
  toDate: string;
}

export interface ImportSummary {
  state: ImportState;
  message: string;
}

export interface ImportProgress {
  completedDays: number;
  totalDays: number;
  etaLabel: string | null;
}

export interface ImportProgressDisplay {
  progress: ImportProgress;
  percent: number;
  title: string;
}

export function parseImportProgressMessage(message: string): ImportProgress | null {
  const segments = message
    .split("·")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const progressSegment = segments.find((segment) => /\d+\s*\/\s*\d+\s*days/i.test(segment));
  if (!progressSegment) {
    return null;
  }

  const progressMatch = progressSegment.match(/(\d+)\s*\/\s*(\d+)\s*days/i);
  if (!progressMatch) {
    return null;
  }

  const completedDays = Number(progressMatch[1]);
  const totalDays = Number(progressMatch[2]);
  if (!Number.isFinite(completedDays) || !Number.isFinite(totalDays) || totalDays <= 0) {
    return null;
  }

  const lastSegment = segments[segments.length - 1] ?? "";
  const etaLabel = lastSegment === progressSegment ? null : lastSegment;

  return { completedDays, totalDays, etaLabel };
}

export function buildImportProgressDisplay(
  summary: ImportSummary,
  range: ImportRange | null,
): ImportProgressDisplay | null {
  if (summary.state !== "running") {
    return null;
  }

  const progress = parseImportProgressMessage(summary.message);
  if (!progress) {
    return null;
  }

  const etaLabel = progress.etaLabel ?? "calculating...";
  const title = range
    ? `Importing from ${range.fromDate} to ${range.toDate} ETA ${etaLabel}`
    : `Import in progress ETA ${etaLabel}`;
  return {
    progress,
    percent: Math.max(0, Math.min(100, Math.round((progress.completedDays / progress.totalDays) * 100))),
    title,
  };
}
