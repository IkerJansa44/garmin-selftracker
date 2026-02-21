import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type CSSProperties,
  type ReactNode,
} from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import clsx from "clsx";
import {
  AlertCircle,
  CirclePlus,
  Download,
  GripVertical,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_QUESTIONS,
  DEFAULT_SELECTED_METRICS,
  METRICS,
  RANGE_PRESETS,
  SECTION_ORDER,
} from "./lib/constants";
import {
  defaultDraftAnswers,
  ema,
  formatReadableDate,
  formatTime,
  generateHistoryFromRecords,
  generateMockRecords,
  histogram,
  mean,
  pearsonCorrelation,
  rollingAverage,
  shiftSeries,
  stdev,
} from "./lib/mockData";
import { usePersistentState } from "./lib/storage";
import {
  type CheckInEntry,
  type CheckInQuestion,
  type CoverageState,
  type DailyRecord,
  type ExploreSettings,
  type ImportState,
  type InputType,
  type MetricKey,
} from "./lib/types";

gsap.registerPlugin(ScrollTrigger);

type ViewKey = "today" | "explore" | "lab" | "checkin" | "settings";

const RECORDS = generateMockRecords();

const IMPORT_STATUS_LABELS: Record<ImportState, string> = {
  ok: "OK",
  running: "Running",
  failed: "Failed",
};

const COVERAGE_META: Record<CoverageState, { label: string; tone: string }> = {
  complete: {
    label: "Complete",
    tone: "text-success bg-[color-mix(in_srgb,var(--success)_12%,white)]",
  },
  partial: {
    label: "Partial",
    tone: "text-warning bg-[color-mix(in_srgb,var(--warning)_14%,white)]",
  },
  missing: {
    label: "Missing",
    tone: "text-error bg-[color-mix(in_srgb,var(--error)_14%,white)]",
  },
};

const METRIC_LIMITS: Record<MetricKey, { min: number; max: number }> = {
  hrv: { min: 30, max: 110 },
  sleepScore: { min: 40, max: 100 },
  restingHr: { min: 42, max: 72 },
  stress: { min: 10, max: 85 },
  bodyBattery: { min: 15, max: 100 },
  trainingReadiness: { min: 20, max: 100 },
};

function getMetricLabel(metric: MetricKey): string {
  return METRICS.find((definition) => definition.key === metric)?.label ?? metric;
}

function getMetricColor(metric: MetricKey): string {
  return METRICS.find((definition) => definition.key === metric)?.color ?? "#cc5833";
}

function getMetricUnit(metric: MetricKey): string {
  return METRICS.find((definition) => definition.key === metric)?.unit ?? "";
}

function normalizeValue(metric: MetricKey, value: number): number {
  const limits = METRIC_LIMITS[metric];
  return ((value - limits.min) / (limits.max - limits.min)) * 100;
}

function formatMetricValue(metric: MetricKey, value: number | null): string {
  if (value === null) {
    return "--";
  }
  const definition = METRICS.find((entry) => entry.key === metric);
  if (!definition) {
    return String(value);
  }
  return `${value.toFixed(definition.decimals)} ${definition.unit}`;
}

function formatDelta(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "--";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}`;
}

function exportQuestions(questions: CheckInQuestion[]): string {
  return JSON.stringify(questions, null, 2);
}

function safeParseQuestions(raw: string): CheckInQuestion[] | null {
  try {
    const parsed = JSON.parse(raw) as CheckInQuestion[];
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((question) =>
      typeof question.id === "string" &&
      typeof question.prompt === "string" &&
      typeof question.section === "string" &&
      typeof question.inputType === "string",
    );
  } catch {
    return null;
  }
}

function sectionedQuestions(questions: CheckInQuestion[]): Record<string, CheckInQuestion[]> {
  return questions.reduce<Record<string, CheckInQuestion[]>>((accumulator, question) => {
    if (!accumulator[question.section]) {
      accumulator[question.section] = [];
    }
    accumulator[question.section].push(question);
    return accumulator;
  }, {});
}

function buildImportSummary(records: DailyRecord[]): {
  state: ImportState;
  lastImportAt: string;
  message: string;
} {
  const today = records[records.length - 1];
  const lastComplete = [...records]
    .reverse()
    .find((record) => Object.values(record.coverage).every((coverage) => coverage === "complete"));

  return {
    state: today.importState,
    lastImportAt: lastComplete ? `${lastComplete.date}T06:07:00` : `${today.date}T06:00:00`,
    message: "Daily import scheduled · 06:00 local",
  };
}

function computeMetricSummary(records: DailyRecord[], metric: MetricKey): {
  todayValue: number | null;
  coverage: CoverageState;
  baselineMean: number;
  baselineStd: number;
  delta: number | null;
  sparklineData: Array<{ i: number; value: number | null }>;
} {
  const today = records[records.length - 1];
  const todayValue = today.metrics[metric];
  const coverage = today.coverage[metric];

  const recent = records.slice(-15, -1).map((record) => record.metrics[metric]);
  const baselineNumbers = recent.filter((value): value is number => value !== null);

  const baselineMean = mean(baselineNumbers);
  const baselineStd = stdev(baselineNumbers);

  return {
    todayValue,
    coverage,
    baselineMean,
    baselineStd,
    delta: todayValue === null ? null : todayValue - baselineMean,
    sparklineData: records.slice(-14).map((record, index) => ({
      i: index,
      value: record.metrics[metric],
    })),
  };
}

function buildHistogram(records: DailyRecord[], metric: MetricKey): Array<{ bucket: string; count: number }> {
  const values = records
    .map((record) => record.metrics[metric])
    .filter((value): value is number => value !== null);
  return histogram(values, 9);
}

function calculateRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  if (xs.length < 2) {
    return { slope: 0, intercept: 0 };
  }
  const avgX = mean(xs);
  const avgY = mean(ys);
  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - avgX) * (ys[index] - avgY);
    denominator += (xs[index] - avgX) ** 2;
  }

  if (denominator === 0) {
    return { slope: 0, intercept: avgY };
  }

  const slope = numerator / denominator;
  return {
    slope,
    intercept: avgY - slope * avgX,
  };
}

function SparklineTooltip({ active, payload }: { active?: boolean; payload?: Array<{ value: number }> }) {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className="rounded-2xl bg-panel px-3 py-2 text-xs shadow-soft">
      <span className="metric-number font-mono">{payload[0]?.value ?? "--"}</span>
    </div>
  );
}

function MagneticButton({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const element = buttonRef.current;
    if (!element) {
      return;
    }

    const context = gsap.context(() => {
      const xTo = gsap.quickTo(element, "x", { duration: 0.2, ease: "power2.out" });
      const yTo = gsap.quickTo(element, "y", { duration: 0.2, ease: "power2.out" });

      const onMove = (event: MouseEvent) => {
        const rect = element.getBoundingClientRect();
        const dx = (event.clientX - (rect.left + rect.width / 2)) * 0.08;
        const dy = (event.clientY - (rect.top + rect.height / 2)) * 0.08;
        xTo(dx);
        yTo(dy);
      };

      const onLeave = () => {
        gsap.to(element, { x: 0, y: 0, scale: 1, duration: 0.25, ease: "power2.out" });
      };

      const onEnter = () => {
        gsap.to(element, { scale: 1.02, duration: 0.2, ease: "power2.out" });
      };

      element.addEventListener("mousemove", onMove);
      element.addEventListener("mouseenter", onEnter);
      element.addEventListener("mouseleave", onLeave);

      return () => {
        element.removeEventListener("mousemove", onMove);
        element.removeEventListener("mouseenter", onEnter);
        element.removeEventListener("mouseleave", onLeave);
      };
    }, buttonRef);

    return () => context.revert();
  }, []);

  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      className={clsx(
        "focusable min-h-11 rounded-capsule bg-panel px-4 text-sm font-semibold text-ink shadow-soft transition hover:brightness-[0.99]",
        className,
      )}
      type="button"
    >
      {children}
    </button>
  );
}

function App() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const chipDockARef = useRef<HTMLDivElement | null>(null);
  const chipDockBRef = useRef<HTMLDivElement | null>(null);

  const [activeView, setActiveView] = usePersistentState<ViewKey>("ui.lastView", "today");
  const [rangePreset, setRangePreset] = usePersistentState<number>("ui.rangePreset", 30);
  const [selectedMetrics, setSelectedMetrics] = usePersistentState<MetricKey[]>(
    "ui.selectedMetrics",
    DEFAULT_SELECTED_METRICS,
  );
  const [exploreSettings, setExploreSettings] = usePersistentState<ExploreSettings>(
    "ui.exploreSettings",
    {
      smoothing: "none",
      baselineBand: true,
      importGaps: true,
      scaleMode: "independent",
      lagDays: 0,
    },
  );
  const [draftAnswers, setDraftAnswers] = usePersistentState<Record<string, string | number | boolean>>(
    "ui.checkinDraft",
    defaultDraftAnswers(),
  );
  const [showQuickCheckin, setShowQuickCheckin] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [highlightTile, setHighlightTile] = useState<MetricKey | null>(null);
  const [scrubIndex, setScrubIndex] = useState(rangePreset - 1);
  const [distributionMetric, setDistributionMetric] = useState<MetricKey>(selectedMetrics[0] ?? "sleepScore");
  const [questionLibrary, setQuestionLibrary] = useState<CheckInQuestion[]>(DEFAULT_QUESTIONS);
  const [selectedQuestionId, setSelectedQuestionId] = useState(DEFAULT_QUESTIONS[0]?.id ?? "");
  const [questionJsonDraft, setQuestionJsonDraft] = useState("");
  const [historyEntries, setHistoryEntries] = useState<CheckInEntry[]>(() => generateHistoryFromRecords(RECORDS));
  const [correlationA, setCorrelationA] = useState<MetricKey>("sleepScore");
  const [correlationB, setCorrelationB] = useState<MetricKey>("trainingReadiness");
  const [weekdayOnly, setWeekdayOnly] = useState(false);
  const [trainingOnly, setTrainingOnly] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor));

  useEffect(() => {
    const context = gsap.context(() => {
      gsap.from(".gsap-fade", {
        y: 20,
        opacity: 0,
        duration: 0.45,
        ease: "power2.out",
        stagger: 0.05,
      });

      if (heroRef.current) {
        gsap.to(heroRef.current, {
          yPercent: -10,
          ease: "none",
          scrollTrigger: {
            trigger: heroRef.current,
            start: "top top",
            end: "bottom top",
            scrub: true,
          },
        });
      }
    }, appRef);

    return () => context.revert();
  }, [activeView]);

  useEffect(() => {
    const onScroll = () => {
      setIsScrolled(window.scrollY > 6);
    };

    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setScrubIndex(rangePreset - 1);
  }, [rangePreset]);

  useEffect(() => {
    const valid = selectedMetrics.filter((metric): metric is MetricKey =>
      METRICS.some((definition) => definition.key === metric),
    );
    if (!valid.length) {
      setSelectedMetrics([DEFAULT_SELECTED_METRICS[0]]);
      return;
    }
    if (valid.length !== selectedMetrics.length) {
      setSelectedMetrics(valid);
    }
  }, [selectedMetrics, setSelectedMetrics]);

  useEffect(() => {
    if (!selectedMetrics.includes(distributionMetric)) {
      setDistributionMetric(selectedMetrics[0] ?? "sleepScore");
    }
  }, [selectedMetrics, distributionMetric]);

  useEffect(() => {
    const dock = correlationA === correlationB ? chipDockBRef.current : chipDockARef.current;
    if (!dock) {
      return;
    }

    const context = gsap.context(() => {
      gsap.fromTo(
        dock,
        { scale: 0.98, boxShadow: "0 0 0 rgba(204,88,51,0)" },
        {
          scale: 1,
          boxShadow: "0 0 0 8px rgba(204,88,51,0)",
          duration: 0.35,
          ease: "power2.out",
        },
      );
    }, dock);

    return () => context.revert();
  }, [correlationA, correlationB]);

  useEffect(() => {
    if (!scrubberRef.current) {
      return;
    }
    const context = gsap.context(() => {
      gsap.fromTo(
        scrubberRef.current,
        { scale: 0.996 },
        { scale: 1, duration: 0.2, ease: "power2.out" },
      );
    }, scrubberRef);

    return () => context.revert();
  }, [scrubIndex]);

  const records = useMemo(() => RECORDS.slice(-rangePreset), [rangePreset]);
  const todayRecord = records[records.length - 1];
  const importSummary = useMemo(() => buildImportSummary(RECORDS), []);

  const metricSummaries = useMemo(
    () =>
      METRICS.map((metric) => ({
        ...metric,
        ...computeMetricSummary(records, metric.key),
      })),
    [records],
  );

  const seriesData = useMemo(() => {
    const data = records.map((record) => {
      const row: Record<string, number | string | boolean | null> = {
        date: record.date,
        importGap: record.importGap,
      };
      selectedMetrics.forEach((metric) => {
        row[metric] = record.metrics[metric];
      });
      return row;
    });

    selectedMetrics.forEach((metric) => {
      const values = data.map((row) => (row[metric] as number | null) ?? null);
      const smoothed = exploreSettings.smoothing === "ema7" ? ema(values, 7) : values;
      smoothed.forEach((value, index) => {
        const normalized = value === null ? null : normalizeValue(metric, value);
        data[index][`${metric}_display`] =
          exploreSettings.scaleMode === "normalized" ? normalized : value;
      });

      const baseline = rollingAverage(values, 14);
      baseline.forEach((value, index) => {
        data[index][`${metric}_baseline`] =
          exploreSettings.scaleMode === "normalized" && value !== null
            ? normalizeValue(metric, value)
            : value;
      });
    });

    return data;
  }, [records, selectedMetrics, exploreSettings]);

  const scrubRecord = records[Math.min(scrubIndex, records.length - 1)] ?? todayRecord;

  const lagChartData = useMemo(() => {
    const sourceMetric = selectedMetrics[0] ?? "sleepScore";
    const compareMetric = selectedMetrics[1] ?? "trainingReadiness";
    const sourceValues = records.map((record) => record.metrics[sourceMetric]);
    const compareValues = records.map((record) => record.metrics[compareMetric]);
    const shifted = shiftSeries(compareValues, exploreSettings.lagDays);

    return records.map((record, index) => ({
      date: record.date,
      source: sourceValues[index],
      shifted: shifted[index],
    }));
  }, [records, selectedMetrics, exploreSettings.lagDays]);

  const histogramData = useMemo(
    () => buildHistogram(records, distributionMetric),
    [records, distributionMetric],
  );

  const correlationData = useMemo(() => {
    const pairs = [] as Array<{ x: number; y: number; date: string }>;
    const lag = exploreSettings.lagDays;

    for (let index = 0; index < records.length - lag; index += 1) {
      const source = records[index];
      const target = records[index + lag];

      if (weekdayOnly && (source.weekday === 0 || source.weekday === 6)) {
        continue;
      }
      if (trainingOnly && !source.isTrainingDay) {
        continue;
      }

      const x = source.metrics[correlationA];
      const y = target.metrics[correlationB];
      if (x === null || y === null) {
        continue;
      }

      pairs.push({ x, y, date: source.date });
    }

    const xs = pairs.map((pair) => pair.x);
    const ys = pairs.map((pair) => pair.y);
    const correlation = pearsonCorrelation(xs, ys);
    const regression = calculateRegression(xs, ys);

    return {
      points: pairs,
      correlation,
      sampleCount: pairs.length,
      regression,
    };
  }, [records, correlationA, correlationB, exploreSettings.lagDays, weekdayOnly, trainingOnly]);

  const trendLineData = useMemo(() => {
    if (correlationData.points.length < 2) {
      return [];
    }
    const xs = correlationData.points.map((point) => point.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    return [
      {
        x: minX,
        y: correlationData.regression.slope * minX + correlationData.regression.intercept,
      },
      {
        x: maxX,
        y: correlationData.regression.slope * maxX + correlationData.regression.intercept,
      },
    ];
  }, [correlationData]);

  const includedQuestions = useMemo(
    () => questionLibrary.filter((question) => question.defaultIncluded),
    [questionLibrary],
  );

  const groupedQuestions = useMemo(() => sectionedQuestions(includedQuestions), [includedQuestions]);

  const selectedQuestion = useMemo(
    () => questionLibrary.find((question) => question.id === selectedQuestionId) ?? null,
    [questionLibrary, selectedQuestionId],
  );

  const todayDateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const handleToggleMetric = (metric: MetricKey) => {
    setSelectedMetrics((previous) => {
      if (previous.includes(metric)) {
        if (previous.length === 1) {
          return previous;
        }
        return previous.filter((entry) => entry !== metric);
      }
      return [...previous, metric];
    });
  };

  const handleQuickSave = () => {
    const today = RECORDS[RECORDS.length - 1].date;
    const entry: CheckInEntry = {
      id: `manual-${Date.now()}`,
      date: today,
      answers: draftAnswers,
      completedAt: new Date().toISOString(),
    };
    setHistoryEntries((previous) => [entry, ...previous]);
    setShowQuickCheckin(false);
    setDraftAnswers(defaultDraftAnswers());
  };

  const handleAddQuestion = () => {
    const id = `question_${Date.now()}`;
    const question: CheckInQuestion = {
      id,
      section: "Recovery",
      prompt: "New question",
      inputType: "text",
      defaultIncluded: true,
    };
    setQuestionLibrary((previous) => [...previous, question]);
    setSelectedQuestionId(id);
  };

  const updateQuestion = (questionId: string, patch: Partial<CheckInQuestion>) => {
    setQuestionLibrary((previous) =>
      previous.map((question) => (question.id === questionId ? { ...question, ...patch } : question)),
    );
  };

  const removeQuestion = (questionId: string) => {
    setQuestionLibrary((previous) => {
      const next = previous.filter((question) => question.id !== questionId);
      if (selectedQuestionId === questionId) {
        setSelectedQuestionId(next[0]?.id ?? "");
      }
      return next;
    });
  };

  const handleQuestionSortEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    setQuestionLibrary((previous) => {
      const oldIndex = previous.findIndex((question) => question.id === active.id);
      const newIndex = previous.findIndex((question) => question.id === over.id);
      return arrayMove(previous, oldIndex, newIndex);
    });
  };

  const handleCorrelationDragEnd = (event: DragEndEvent) => {
    if (!event.over) {
      return;
    }
    const metric = event.active.id as MetricKey;
    if (event.over.id === "dock-a") {
      setCorrelationA(metric);
    }
    if (event.over.id === "dock-b") {
      setCorrelationB(metric);
    }
  };

  const scrubberLabel = useMemo(() => {
    if (!scrubRecord) {
      return "";
    }

    const deltas = selectedMetrics
      .map((metric) => {
        const index = records.findIndex((record) => record.date === scrubRecord.date);
        if (index <= 0) {
          return `${getMetricLabel(metric)} --`;
        }
        const previous = records[index - 1].metrics[metric];
        const current = scrubRecord.metrics[metric];
        if (current === null || previous === null) {
          return `${getMetricLabel(metric)} --`;
        }
        return `${getMetricLabel(metric)} ${formatDelta(current - previous)}`;
      })
      .join(" · ");

    return `${formatReadableDate(scrubRecord.date)} · ${deltas}`;
  }, [scrubRecord, selectedMetrics, records]);

  const topViewButtons: Array<{ key: ViewKey; label: string }> = [
    { key: "today", label: "Today" },
    { key: "explore", label: "Explore" },
    { key: "lab", label: "Correlation" },
    { key: "checkin", label: "Check-In" },
    { key: "settings", label: "Settings" },
  ];

  const renderQuestionInput = (question: CheckInQuestion) => {
    const value = draftAnswers[question.id];

    if (question.inputType === "slider") {
      return (
        <div className="space-y-2">
          <input
            className="focusable h-11 w-full cursor-pointer accent-accent"
            min={question.min ?? 0}
            max={question.max ?? 10}
            step={question.step ?? 1}
            type="range"
            value={typeof value === "number" ? value : question.min ?? 0}
            onChange={(event) =>
              setDraftAnswers((previous) => ({ ...previous, [question.id]: Number(event.target.value) }))
            }
          />
          <div className="metric-number text-sm text-muted">{String(value ?? question.min ?? 0)}</div>
        </div>
      );
    }

    if (question.inputType === "multi-choice") {
      return (
        <div className="flex flex-wrap gap-2">
          {(question.options ?? []).map((option) => {
            const selected = value === option.id;
            return (
              <button
                key={option.id}
                className={clsx(
                  "focusable min-h-11 rounded-capsule px-4 py-2 text-sm shadow-soft transition",
                  selected ? "bg-accent text-white" : "bg-subsurface text-ink",
                )}
                type="button"
                onClick={() => setDraftAnswers((previous) => ({ ...previous, [question.id]: option.id }))}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      );
    }

    if (question.inputType === "boolean") {
      return (
        <div className="flex gap-3">
          {[true, false].map((candidate) => (
            <button
              key={String(candidate)}
              className={clsx(
                "focusable min-h-11 rounded-capsule px-5 py-2 text-sm shadow-soft transition",
                value === candidate ? "bg-accent text-white" : "bg-subsurface text-ink",
              )}
              type="button"
              onClick={() => setDraftAnswers((previous) => ({ ...previous, [question.id]: candidate }))}
            >
              {candidate ? "Yes" : "No"}
            </button>
          ))}
        </div>
      );
    }

    if (question.inputType === "time") {
      return (
        <input
          className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3"
          type="time"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => setDraftAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))}
        />
      );
    }

    return (
      <textarea
        className="focusable min-h-24 w-full rounded-2xl bg-subsurface p-3"
        placeholder="Optional note"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => setDraftAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))}
      />
    );
  };

  return (
    <div ref={appRef} className="min-h-screen px-4 pb-10 pt-32 text-ink sm:px-6 lg:px-9">
      <header
        className={clsx(
          "fixed inset-x-3 top-4 z-50 rounded-[32px] bg-[rgba(255,255,255,0.78)] p-3 shadow-soft transition lg:inset-x-7",
          isScrolled && "backdrop-blur-md",
        )}
      >
        <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr_1fr]">
          <div className="panel gsap-fade flex min-h-16 items-center justify-between px-4 py-2">
            <div>
              <p className="text-sm text-muted">Garmin Selftracker</p>
              <p className="text-lg font-semibold tracking-tight">{todayDateLabel}</p>
            </div>
            <div className="flex gap-2 rounded-capsule bg-subsurface p-1">
              {RANGE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  className={clsx(
                    "focusable min-h-11 rounded-capsule px-4 text-sm font-semibold transition",
                    rangePreset === preset ? "bg-accent text-white" : "text-muted hover:text-ink",
                  )}
                  type="button"
                  onClick={() => setRangePreset(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="panel gsap-fade flex min-h-16 items-center justify-between px-4 py-2">
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-muted">Import</p>
              <p className="text-sm font-semibold">{importSummary.message}</p>
              <p className="metric-number text-xs text-muted">
                Last import {formatReadableDate(importSummary.lastImportAt.slice(0, 10))} {formatTime(importSummary.lastImportAt)}
              </p>
            </div>
            <div
              className={clsx(
                "rounded-capsule px-3 py-2 text-sm font-semibold",
                importSummary.state === "ok" && "bg-[color-mix(in_srgb,var(--success)_14%,white)] text-success",
                importSummary.state === "running" && "bg-[color-mix(in_srgb,var(--warning)_16%,white)] text-warning",
                importSummary.state === "failed" && "bg-[color-mix(in_srgb,var(--error)_16%,white)] text-error",
              )}
            >
              {IMPORT_STATUS_LABELS[importSummary.state]}
            </div>
          </div>

          <div className="gsap-fade flex items-center justify-end gap-2">
            <MagneticButton onClick={() => setShowQuickCheckin(true)}>
              <span className="inline-flex items-center gap-2">
                <CirclePlus className="size-4" /> Add Check-In
              </span>
            </MagneticButton>
            <MagneticButton onClick={() => setActiveView("explore")}>Explore</MagneticButton>
            <MagneticButton onClick={() => setActiveView("settings")}>Settings</MagneticButton>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-8">
        <div className="gsap-fade flex flex-wrap gap-2">
          {topViewButtons.map((button) => (
            <button
              key={button.key}
              className={clsx(
                "focusable min-h-11 rounded-capsule px-4 text-sm font-semibold shadow-soft transition",
                activeView === button.key ? "bg-accent text-white" : "bg-panel text-ink",
              )}
              type="button"
              onClick={() => setActiveView(button.key)}
            >
              {button.label}
            </button>
          ))}
        </div>

        {activeView === "today" && (
          <section ref={heroRef} className="panel gsap-fade overflow-hidden p-7 sm:p-10">
            <div className="min-h-[42vh] rounded-[30px] bg-[radial-gradient(circle_at_0%_5%,#ffffff_0%,#f8f6f1_40%,#efede6_100%)] p-8 shadow-inset">
              <p className="text-sm text-muted">Daily Console</p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-5xl font-semibold tracking-tight">Today</h1>
                <p className="text-lg text-muted">Readiness clarity in one glance.</p>
              </div>

              <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {metricSummaries.map((summary) => {
                  const showHint = highlightTile === summary.key;
                  const coverageMeta = COVERAGE_META[summary.coverage];
                  const isMissing = summary.coverage === "missing";
                  const isPartial = summary.coverage === "partial";
                  const loadingState = todayRecord.importState === "running" && summary.coverage !== "complete";
                  const errorState = todayRecord.importState === "failed" && isMissing;

                  return (
                    <article
                      key={summary.key}
                      className="rounded-[24px] bg-panel p-5 shadow-soft"
                      onMouseEnter={() => setHighlightTile(summary.key)}
                      onMouseLeave={() => setHighlightTile(null)}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm text-muted">{summary.label}</p>
                          <p className="metric-number mt-2 text-3xl font-semibold tracking-tight">
                            {formatMetricValue(summary.key, summary.todayValue)}
                          </p>
                          <p className="metric-number mt-1 text-xs text-muted">
                            vs 14d baseline {formatDelta(summary.delta)}
                          </p>
                        </div>
                        <span className={clsx("rounded-capsule px-3 py-1 text-xs font-semibold", coverageMeta.tone)}>
                          {coverageMeta.label}
                        </span>
                      </div>

                      <div className="mt-4 h-16">
                        <ResponsiveContainer>
                          <ComposedChart data={summary.sparklineData}>
                            {showHint && (
                              <ReferenceArea
                                ifOverflow="extendDomain"
                                y1={summary.baselineMean - summary.baselineStd}
                                y2={summary.baselineMean + summary.baselineStd}
                                fill="rgba(204, 88, 51, 0.12)"
                              />
                            )}
                            <Line
                              dataKey="value"
                              dot={false}
                              stroke={summary.color}
                              strokeWidth={2}
                              type="monotone"
                            />
                            {showHint && (
                              <Line
                                data={summary.sparklineData.slice(-1)}
                                dataKey="value"
                                dot={{ r: 3, fill: "#CC5833", strokeWidth: 0 }}
                                stroke="transparent"
                              />
                            )}
                            <Tooltip content={<SparklineTooltip />} />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="mt-3 min-h-8 text-xs text-muted">
                        {loadingState ? (
                          <span className="inline-flex items-center gap-2 text-warning">
                            <LoaderCircle className="size-3 animate-spin" /> Import in progress. This tile will
                            update when sync completes.
                          </span>
                        ) : errorState ? (
                          <span className="inline-flex items-center gap-2 text-error">
                            <AlertCircle className="size-3" />
                            No data yet. Last import failed.
                            <button
                              className="focusable rounded-capsule bg-[color-mix(in_srgb,var(--error)_14%,white)] px-2 py-1 text-[11px]"
                              type="button"
                              onClick={() => setActiveView("settings")}
                            >
                              Open status
                            </button>
                          </span>
                        ) : isPartial ? (
                          <span>Partial telemetry. Baseline is computed from available samples only.</span>
                        ) : (
                          <span>{summary.baselineHint}</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {activeView === "explore" && (
          <section className="panel gsap-fade space-y-6 p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">Chart Canvas</h2>
              <div className="flex flex-wrap gap-2">
                {METRICS.map((metric) => {
                  const active = selectedMetrics.includes(metric.key);
                  return (
                    <button
                      key={metric.key}
                      className={clsx(
                        "focusable min-h-11 rounded-capsule px-4 text-sm font-semibold shadow-soft transition",
                        active ? "bg-accent text-white" : "bg-subsurface text-muted",
                      )}
                      type="button"
                      onClick={() => handleToggleMetric(metric.key)}
                    >
                      {metric.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 rounded-[26px] bg-subsurface p-4 lg:grid-cols-6">
              <div className="lg:col-span-2">
                <label className="text-xs uppercase tracking-[0.16em] text-muted">Smoothing</label>
                <div className="mt-2 flex gap-2">
                  {[
                    { key: "none", label: "None" },
                    { key: "ema7", label: "7-day EMA" },
                  ].map((option) => (
                    <button
                      key={option.key}
                      className={clsx(
                        "focusable min-h-11 rounded-capsule px-3 text-sm shadow-soft",
                        exploreSettings.smoothing === option.key ? "bg-accent text-white" : "bg-panel",
                      )}
                      type="button"
                      onClick={() =>
                        setExploreSettings((previous) => ({
                          ...previous,
                          smoothing: option.key as ExploreSettings["smoothing"],
                        }))
                      }
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <ToggleBlock
                checked={exploreSettings.baselineBand}
                label="Baseline band"
                onChange={(value) =>
                  setExploreSettings((previous) => ({ ...previous, baselineBand: value }))
                }
              />
              <ToggleBlock
                checked={exploreSettings.importGaps}
                label="Import gaps"
                onChange={(value) => setExploreSettings((previous) => ({ ...previous, importGaps: value }))}
              />
              <div>
                <label className="text-xs uppercase tracking-[0.16em] text-muted">Scale Mode</label>
                <div className="mt-2 flex gap-2">
                  {[
                    { key: "independent", label: "Independent" },
                    { key: "normalized", label: "Normalized" },
                  ].map((mode) => (
                    <button
                      key={mode.key}
                      className={clsx(
                        "focusable min-h-11 rounded-capsule px-3 text-sm shadow-soft",
                        exploreSettings.scaleMode === mode.key ? "bg-accent text-white" : "bg-panel",
                      )}
                      type="button"
                      onClick={() =>
                        setExploreSettings((previous) => ({
                          ...previous,
                          scaleMode: mode.key as ExploreSettings["scaleMode"],
                        }))
                      }
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.16em] text-muted">Lag View</label>
                <div className="mt-2 flex gap-2">
                  {[0, 1, 2].map((lag) => (
                    <button
                      key={lag}
                      className={clsx(
                        "focusable min-h-11 rounded-capsule px-3 text-sm shadow-soft",
                        exploreSettings.lagDays === lag ? "bg-accent text-white" : "bg-panel",
                      )}
                      type="button"
                      onClick={() =>
                        setExploreSettings((previous) => ({
                          ...previous,
                          lagDays: lag as 0 | 1 | 2,
                        }))
                      }
                    >
                      +{lag}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <article className="rounded-[26px] bg-panel p-5 shadow-soft">
              <header className="mb-3 flex items-center justify-between">
                <h3 className="text-lg font-semibold">Time Series</h3>
                <p className="text-sm text-muted">Independent y-axis per metric by default</p>
              </header>
              <div className="h-[360px]">
                <ResponsiveContainer>
                  <ComposedChart data={seriesData} margin={{ top: 12, right: 24, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(18,18,18,0.06)" strokeDasharray="2 8" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: "rgba(18,18,18,0.62)", fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={24}
                      tickFormatter={(value) => new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    />
                    {exploreSettings.scaleMode === "normalized" ? (
                      <YAxis
                        yAxisId="shared"
                        domain={[0, 100]}
                        tick={{ fill: "rgba(18,18,18,0.62)", fontSize: 12 }}
                        axisLine={false}
                        tickLine={false}
                      />
                    ) : (
                      selectedMetrics.map((metric, index) => (
                        <YAxis
                          key={metric}
                          yAxisId={metric}
                          orientation={index % 2 === 0 ? "left" : "right"}
                          hide={index > 1}
                          domain={["auto", "auto"]}
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: "rgba(18,18,18,0.62)", fontSize: 12 }}
                        />
                      ))
                    )}
                    <Tooltip
                      contentStyle={{
                        borderRadius: 20,
                        border: "none",
                        boxShadow: "0 12px 30px rgba(18,18,18,0.08)",
                        background: "#fff",
                      }}
                      formatter={(value: number | null, key) => {
                        const metric = String(key).replace("_display", "") as MetricKey;
                        if (value === null) {
                          return ["--", getMetricLabel(metric)];
                        }
                        if (exploreSettings.scaleMode === "normalized") {
                          return [`${value.toFixed(1)}%`, getMetricLabel(metric)];
                        }
                        return [`${value.toFixed(1)} ${getMetricUnit(metric)}`, getMetricLabel(metric)];
                      }}
                      labelFormatter={(value) => formatReadableDate(String(value))}
                    />
                    <Legend />
                    {exploreSettings.importGaps &&
                      seriesData
                        .filter((entry) => entry.importGap)
                        .map((entry) => (
                          <ReferenceArea
                            key={`gap-${entry.date}`}
                            fill="rgba(176,88,79,0.10)"
                            x1={entry.date as string}
                            x2={entry.date as string}
                          />
                        ))}
                    {selectedMetrics.map((metric) => (
                      <Line
                        key={metric}
                        yAxisId={exploreSettings.scaleMode === "normalized" ? "shared" : metric}
                        type="monotone"
                        dataKey={`${metric}_display`}
                        name={getMetricLabel(metric)}
                        stroke={getMetricColor(metric)}
                        dot={false}
                        strokeWidth={2.25}
                        isAnimationActive={false}
                      />
                    ))}
                    {exploreSettings.baselineBand &&
                      selectedMetrics.map((metric) => (
                        <Line
                          key={`${metric}-baseline`}
                          yAxisId={exploreSettings.scaleMode === "normalized" ? "shared" : metric}
                          type="monotone"
                          dataKey={`${metric}_baseline`}
                          name={`${getMetricLabel(metric)} baseline`}
                          stroke="rgba(18,18,18,0.28)"
                          strokeDasharray="3 8"
                          dot={false}
                          strokeWidth={1.1}
                          isAnimationActive={false}
                        />
                      ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </article>

            <div className="grid gap-5 xl:grid-cols-2">
              <article className="rounded-[26px] bg-panel p-5 shadow-soft">
                <header className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Distribution</h3>
                  <select
                    className="focusable min-h-11 rounded-capsule bg-subsurface px-3 text-sm"
                    value={distributionMetric}
                    onChange={(event) => setDistributionMetric(event.target.value as MetricKey)}
                  >
                    {selectedMetrics.map((metric) => (
                      <option key={metric} value={metric}>
                        {getMetricLabel(metric)}
                      </option>
                    ))}
                  </select>
                </header>
                <div className="h-[240px]">
                  <ResponsiveContainer>
                    <BarChart data={histogramData}>
                      <CartesianGrid stroke="rgba(18,18,18,0.05)" vertical={false} />
                      <XAxis dataKey="bucket" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Bar dataKey="count" fill={getMetricColor(distributionMetric)} radius={[12, 12, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </article>

              <article className="rounded-[26px] bg-panel p-5 shadow-soft">
                <header className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Lag View (+{exploreSettings.lagDays})</h3>
                  <p className="text-sm text-muted">Source vs shifted comparison</p>
                </header>
                <div className="h-[240px]">
                  <ResponsiveContainer>
                    <ComposedChart data={lagChartData}>
                      <CartesianGrid stroke="rgba(18,18,18,0.06)" vertical={false} />
                      <XAxis dataKey="date" hide />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Line type="monotone" dataKey="source" stroke={getMetricColor(selectedMetrics[0] ?? "sleepScore")} dot={false} />
                      <Line
                        type="monotone"
                        dataKey="shifted"
                        stroke={getMetricColor(selectedMetrics[1] ?? "trainingReadiness")}
                        strokeDasharray="6 4"
                        dot={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </article>
            </div>

            <article ref={scrubberRef} className="rounded-[26px] bg-subsurface p-5 shadow-inset">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">Ceramic Scrubber</h3>
                <span className="metric-number text-sm text-ink">{scrubberLabel}</span>
              </div>
              <input
                className="focusable h-12 w-full cursor-pointer accent-accent"
                max={Math.max(records.length - 1, 0)}
                min={0}
                step={1}
                type="range"
                value={Math.min(scrubIndex, records.length - 1)}
                onChange={(event) => setScrubIndex(Number(event.target.value))}
              />
            </article>
          </section>
        )}

        {activeView === "lab" && (
          <section className="panel gsap-fade grid gap-5 p-6 sm:grid-cols-[340px_1fr] sm:p-8">
            <DndContext sensors={sensors} onDragEnd={handleCorrelationDragEnd}>
              <aside className="space-y-4 rounded-[24px] bg-subsurface p-4">
                <h2 className="text-xl font-semibold tracking-tight">Correlation Lab</h2>

                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Chip Dock</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {METRICS.map((metric) => (
                      <DraggableMetricChip key={metric.key} metric={metric.key} />
                    ))}
                  </div>
                </div>

                <DropDock
                  refObject={chipDockARef}
                  title="A"
                  metric={correlationA}
                  dockId="dock-a"
                />
                <DropDock
                  refObject={chipDockBRef}
                  title="B"
                  metric={correlationB}
                  dockId="dock-b"
                />

                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Lag</p>
                  <div className="mt-2 flex gap-2">
                    {[0, 1, 2].map((lag) => (
                      <button
                        key={lag}
                        className={clsx(
                          "focusable min-h-11 rounded-capsule px-4 text-sm shadow-soft",
                          exploreSettings.lagDays === lag ? "bg-accent text-white" : "bg-panel",
                        )}
                        type="button"
                        onClick={() =>
                          setExploreSettings((previous) => ({
                            ...previous,
                            lagDays: lag as 0 | 1 | 2,
                          }))
                        }
                      >
                        +{lag}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center justify-between rounded-2xl bg-panel p-3 text-sm">
                  Weekdays only
                  <input
                    checked={weekdayOnly}
                    type="checkbox"
                    onChange={(event) => setWeekdayOnly(event.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-between rounded-2xl bg-panel p-3 text-sm">
                  Training days only
                  <input
                    checked={trainingOnly}
                    type="checkbox"
                    onChange={(event) => setTrainingOnly(event.target.checked)}
                  />
                </label>
              </aside>

              <article className="rounded-[24px] bg-panel p-5 shadow-soft">
                <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold tracking-tight">
                      {getMetricLabel(correlationA)} vs {getMetricLabel(correlationB)}
                    </h3>
                    <p className="metric-number text-sm text-muted">
                      r = {correlationData.correlation.toFixed(2)} · N={correlationData.sampleCount}
                    </p>
                  </div>
                  {correlationData.sampleCount < 20 && (
                    <p className="rounded-capsule bg-[color-mix(in_srgb,var(--warning)_16%,white)] px-3 py-2 text-sm text-warning">
                      Low sample size (N={correlationData.sampleCount}). Interpret cautiously.
                    </p>
                  )}
                </header>

                <div className="h-[420px]">
                  <ResponsiveContainer>
                    <ScatterChart>
                      <CartesianGrid stroke="rgba(18,18,18,0.06)" strokeDasharray="3 6" />
                      <XAxis
                        dataKey="x"
                        name={getMetricLabel(correlationA)}
                        unit={getMetricUnit(correlationA)}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis
                        dataKey="y"
                        name={getMetricLabel(correlationB)}
                        unit={getMetricUnit(correlationB)}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 12 }}
                      />
                      <Tooltip
                        cursor={{ strokeDasharray: "3 4" }}
                        formatter={(value: number, key) => [`${value.toFixed(1)}`, key]}
                        labelFormatter={(label, payload) => {
                          const date = payload?.[0]?.payload?.date;
                          return date ? formatReadableDate(date) : String(label);
                        }}
                      />
                      <Scatter data={correlationData.points} fill={getMetricColor(correlationA)} />
                      <Scatter
                        data={trendLineData}
                        fill="transparent"
                        line={{ stroke: "#CC5833", strokeWidth: 2 }}
                        shape={() => null}
                        legendType="none"
                        name="Trend"
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </article>
            </DndContext>
          </section>
        )}

        {activeView === "checkin" && (
          <section className="gsap-fade grid gap-6 xl:grid-cols-[1.3fr_1fr]">
            <article className="panel p-6 sm:p-8">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-2xl font-semibold tracking-tight">End-of-Day Check-In</h2>
                <button
                  className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-sm font-semibold shadow-soft"
                  type="button"
                  onClick={() => setShowQuickCheckin(true)}
                >
                  Launch modal
                </button>
              </div>

              <div className="space-y-5">
                {SECTION_ORDER.map((section) => {
                  const questions = groupedQuestions[section];
                  if (!questions?.length) {
                    return null;
                  }
                  return (
                    <div key={section} className="rounded-[22px] bg-subsurface p-4">
                      <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.16em] text-muted">{section}</h3>
                      <div className="space-y-4">
                        {questions.map((question) => (
                          <div key={question.id} className="rounded-2xl bg-panel p-4 shadow-soft">
                            <p className="mb-3 text-sm font-medium">{question.prompt}</p>
                            {renderQuestionInput(question)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  className="focusable min-h-11 rounded-capsule bg-accent px-6 text-sm font-semibold text-white shadow-soft"
                  type="button"
                  onClick={handleQuickSave}
                >
                  Save Check-In
                </button>
              </div>
            </article>

            <div className="space-y-6">
              <article className="panel p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-xl font-semibold">History</h3>
                  <span className="text-sm text-muted">{historyEntries.length} entries</span>
                </div>
                <div className="scrollbar-hide max-h-[460px] space-y-3 overflow-y-auto pr-1">
                  {historyEntries.slice(0, 20).map((entry) => (
                    <div key={entry.id} className="rounded-2xl bg-subsurface p-3">
                      <p className="text-sm font-semibold">{formatReadableDate(entry.date)}</p>
                      <p className="text-xs text-muted">Completed {formatTime(entry.completedAt)}</p>
                    </div>
                  ))}
                </div>
              </article>

              <article className="panel p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-xl font-semibold">Question Builder</h3>
                  <button
                    className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-sm shadow-soft"
                    type="button"
                    onClick={handleAddQuestion}
                  >
                    <span className="inline-flex items-center gap-2">
                      <CirclePlus className="size-4" /> Add
                    </span>
                  </button>
                </div>

                <DndContext sensors={sensors} onDragEnd={handleQuestionSortEnd}>
                  <SortableContext
                    items={questionLibrary.map((question) => question.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2">
                      {questionLibrary.map((question) => (
                        <SortableQuestionItem
                          key={question.id}
                          isSelected={question.id === selectedQuestionId}
                          question={question}
                          onSelect={() => setSelectedQuestionId(question.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                {selectedQuestion && (
                  <QuestionEditor
                    question={selectedQuestion}
                    onDelete={() => removeQuestion(selectedQuestion.id)}
                    onPatch={(patch) => updateQuestion(selectedQuestion.id, patch)}
                  />
                )}

                <div className="mt-5 rounded-2xl bg-subsurface p-3">
                  <div className="mb-2 flex gap-2">
                    <button
                      className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm shadow-soft"
                      type="button"
                      onClick={() => setQuestionJsonDraft(exportQuestions(questionLibrary))}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Download className="size-4" /> Export JSON
                      </span>
                    </button>
                    <button
                      className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm shadow-soft"
                      type="button"
                      onClick={() => {
                        const parsed = safeParseQuestions(questionJsonDraft);
                        if (parsed?.length) {
                          setQuestionLibrary(parsed);
                          setSelectedQuestionId(parsed[0].id);
                        }
                      }}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Upload className="size-4" /> Import JSON
                      </span>
                    </button>
                  </div>
                  <textarea
                    className="focusable min-h-28 w-full rounded-2xl bg-panel p-3 text-xs font-mono"
                    placeholder="Paste or generate JSON"
                    value={questionJsonDraft}
                    onChange={(event) => setQuestionJsonDraft(event.target.value)}
                  />
                </div>
              </article>
            </div>
          </section>
        )}

        {activeView === "settings" && (
          <section className="panel gsap-fade grid gap-5 p-6 sm:grid-cols-2 sm:p-8">
            <article className="rounded-[24px] bg-subsurface p-5">
              <h3 className="text-lg font-semibold">Daily Import Schedule</h3>
              <p className="mt-2 text-sm text-muted">Scheduled every day at 06:00 local. UI simulation states only.</p>
              <div className="mt-4 rounded-2xl bg-panel p-4">
                <p className="text-sm font-semibold">State: {IMPORT_STATUS_LABELS[importSummary.state]}</p>
                <p className="metric-number text-sm text-muted">
                  Last import {formatReadableDate(importSummary.lastImportAt.slice(0, 10))} {formatTime(importSummary.lastImportAt)}
                </p>
              </div>
            </article>

            <article className="rounded-[24px] bg-subsurface p-5">
              <h3 className="text-lg font-semibold">Connection / Token</h3>
              <p className="mt-2 text-sm text-muted">Placeholder only. Backend integration out of scope.</p>
              <div className="mt-4 rounded-2xl bg-panel p-4 text-sm">Token status: Not connected</div>
            </article>

            <article className="rounded-[24px] bg-subsurface p-5">
              <h3 className="text-lg font-semibold">Data Retention</h3>
              <p className="mt-2 text-sm text-muted">Fixed retention: 365 days.</p>
              <div className="mt-4 rounded-2xl bg-panel p-4 text-sm">Local-first. Single user.</div>
            </article>

            <article className="rounded-[24px] bg-subsurface p-5">
              <h3 className="text-lg font-semibold">Export</h3>
              <p className="mt-2 text-sm text-muted">CSV/JSON export UI stub.</p>
              <div className="mt-4 flex gap-2">
                <button className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm shadow-soft" type="button">
                  Export CSV
                </button>
                <button className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm shadow-soft" type="button">
                  Export JSON
                </button>
              </div>
            </article>
          </section>
        )}
      </main>

      <footer className="mx-auto mt-10 flex w-full max-w-[1400px] items-center justify-between rounded-[24px] bg-panel px-5 py-4 shadow-soft">
        <span className="text-sm text-muted">Ceramic Ops Console</span>
        <span className="inline-flex items-center gap-2 text-sm text-success">
          <span className="size-2 rounded-full bg-success" /> System Operational
        </span>
      </footer>

      {showQuickCheckin && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-[rgba(18,18,18,0.2)] p-4 backdrop-blur-xs">
          <div className="panel w-full max-w-2xl p-6">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Quick End-of-Day Check-In</h2>
              <button
                className="focusable min-h-11 rounded-capsule bg-subsurface px-3"
                type="button"
                onClick={() => setShowQuickCheckin(false)}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="max-h-[58vh] space-y-4 overflow-y-auto pr-1">
              {includedQuestions.slice(0, 8).map((question) => (
                <div key={question.id} className="rounded-2xl bg-subsurface p-3">
                  <p className="mb-2 text-sm font-medium">{question.prompt}</p>
                  {renderQuestionInput(question)}
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-sm"
                type="button"
                onClick={() => setShowQuickCheckin(false)}
              >
                Cancel
              </button>
              <button
                className="focusable min-h-11 rounded-capsule bg-accent px-5 text-sm font-semibold text-white"
                type="button"
                onClick={handleQuickSave}
              >
                Save Check-In
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleBlock({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-2xl bg-panel px-3 py-2">
      <span className="text-sm">{label}</span>
      <input checked={checked} type="checkbox" onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function DraggableMetricChip({ metric }: { metric: MetricKey }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: metric });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.7 : 1,
  };

  return (
    <button
      ref={setNodeRef}
      className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm font-semibold shadow-soft"
      style={style}
      type="button"
      {...listeners}
      {...attributes}
    >
      {getMetricLabel(metric)}
    </button>
  );
}

function DropDock({
  dockId,
  title,
  metric,
  refObject,
}: {
  dockId: string;
  title: string;
  metric: MetricKey;
  refObject: MutableRefObject<HTMLDivElement | null>;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: dockId });

  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        refObject.current = element;
      }}
      className={clsx(
        "relative rounded-2xl bg-panel p-3 transition",
        isOver && "scale-[1.01] ring-2 ring-[color:var(--accent)]/35",
      )}
    >
      <p className="text-xs uppercase tracking-[0.16em] text-muted">Dock {title}</p>
      <p className="mt-1 text-sm font-semibold">{getMetricLabel(metric)}</p>
      {isOver && <span className="pointer-events-none absolute inset-0 rounded-2xl border border-accent/30 animate-pulseSoft" />}
    </div>
  );
}

function SortableQuestionItem({
  question,
  isSelected,
  onSelect,
}: {
  question: CheckInQuestion;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: question.id });

  return (
    <button
      ref={setNodeRef}
      className={clsx(
        "focusable flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left shadow-soft transition",
        isSelected ? "bg-accent text-white" : "bg-subsurface text-ink",
      )}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      type="button"
      onClick={onSelect}
    >
      <span>
        <span className="block text-sm font-semibold">{question.prompt}</span>
        <span className="block text-xs opacity-70">{question.inputType}</span>
      </span>
      <span className="inline-flex items-center gap-2" {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </span>
    </button>
  );
}

function QuestionEditor({
  question,
  onPatch,
  onDelete,
}: {
  question: CheckInQuestion;
  onPatch: (patch: Partial<CheckInQuestion>) => void;
  onDelete: () => void;
}) {
  const optionsText = (question.options ?? []).map((option) => option.label).join(", ");

  const renderTypeMeta = (inputType: InputType) => {
    if (inputType === "slider") {
      return (
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            className="focusable min-h-11 rounded-2xl bg-panel px-3"
            placeholder="Min"
            type="number"
            value={question.min ?? 0}
            onChange={(event) => onPatch({ min: Number(event.target.value) })}
          />
          <input
            className="focusable min-h-11 rounded-2xl bg-panel px-3"
            placeholder="Max"
            type="number"
            value={question.max ?? 10}
            onChange={(event) => onPatch({ max: Number(event.target.value) })}
          />
          <input
            className="focusable min-h-11 rounded-2xl bg-panel px-3"
            placeholder="Step"
            type="number"
            value={question.step ?? 1}
            onChange={(event) => onPatch({ step: Number(event.target.value) })}
          />
        </div>
      );
    }

    if (inputType === "multi-choice") {
      return (
        <textarea
          className="focusable min-h-20 w-full rounded-2xl bg-panel p-3 text-sm"
          placeholder="Option 1, Option 2"
          value={optionsText}
          onChange={(event) => {
            const options = event.target.value
              .split(",")
              .map((label) => label.trim())
              .filter(Boolean)
              .map((label, index) => ({ id: `${question.id}_${index}`, label }));
            onPatch({ options });
          }}
        />
      );
    }

    return null;
  };

  return (
    <div className="mt-4 rounded-2xl bg-subsurface p-3">
      <p className="mb-2 text-sm font-semibold">Edit Question</p>
      <div className="space-y-2">
        <input
          className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
          value={question.prompt}
          onChange={(event) => onPatch({ prompt: event.target.value })}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            className="focusable min-h-11 rounded-2xl bg-panel px-3"
            value={question.section}
            onChange={(event) => onPatch({ section: event.target.value })}
          >
            {SECTION_ORDER.map((section) => (
              <option key={section}>{section}</option>
            ))}
          </select>
          <select
            className="focusable min-h-11 rounded-2xl bg-panel px-3"
            value={question.inputType}
            onChange={(event) => onPatch({ inputType: event.target.value as InputType })}
          >
            <option value="slider">slider</option>
            <option value="multi-choice">multi-choice</option>
            <option value="boolean">boolean</option>
            <option value="time">time</option>
            <option value="text">text</option>
          </select>
        </div>
        {renderTypeMeta(question.inputType)}

        <div className="rounded-2xl bg-panel p-3">
          <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted">Preview</p>
          <div className="rounded-2xl bg-subsurface p-3">
            <p className="mb-2 text-sm font-medium">{question.prompt}</p>
            {question.inputType === "slider" && (
              <input className="h-11 w-full accent-accent" disabled type="range" />
            )}
            {question.inputType === "multi-choice" && (
              <div className="flex flex-wrap gap-2">
                {(question.options ?? [{ id: "opt", label: "Option" }]).map((option) => (
                  <span key={option.id} className="rounded-capsule bg-panel px-3 py-2 text-xs">
                    {option.label}
                  </span>
                ))}
              </div>
            )}
            {question.inputType === "boolean" && (
              <div className="flex gap-2 text-xs">
                <span className="rounded-capsule bg-panel px-3 py-2">Yes</span>
                <span className="rounded-capsule bg-panel px-3 py-2">No</span>
              </div>
            )}
            {question.inputType === "time" && (
              <input className="min-h-11 rounded-capsule bg-panel px-3 text-sm" disabled type="time" />
            )}
            {question.inputType === "text" && (
              <textarea className="min-h-20 w-full rounded-2xl bg-panel p-3 text-sm" disabled />
            )}
          </div>
        </div>

        <label className="flex items-center justify-between rounded-2xl bg-panel px-3 py-2 text-sm">
          Included by default
          <input
            checked={question.defaultIncluded}
            type="checkbox"
            onChange={(event) => onPatch({ defaultIncluded: event.target.checked })}
          />
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          className="focusable min-h-11 rounded-capsule bg-[color-mix(in_srgb,var(--error)_16%,white)] px-4 text-sm text-error"
          type="button"
          onClick={onDelete}
        >
          Delete question
        </button>
      </div>
    </div>
  );
}

export default App;
