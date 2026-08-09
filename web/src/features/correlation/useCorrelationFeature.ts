import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEventHandler,
  type RefObject,
  type SetStateAction,
} from "react";
import { formatReadableDate } from "../../lib/mockData";
import { mean } from "../../lib/mockData";
import { METRICS } from "../../lib/constants";
import {
  DERIVED_GAP_METRICS,
  DERIVED_GAP_METRIC_KEYS,
  type DerivedGapMetricKey,
} from "../../lib/derivedMetrics";
import {
  buildCorrelationCatalog,
  buildDerivedPredictorSourceOptions,
  buildOutcomeOptions,
  buildPredictorDistribution,
  buildPredictorOptions,
  calculateQuantileCutPoints,
  findCorrelationPair,
  getOptionLabel,
  type BasePredictorKey,
  type CorrelationOption,
  type CorrelationPairResult,
  type OutcomeKey,
  type PredictorKey,
} from "../../lib/correlation";
import { flattenQuestionFields, type QuestionFieldDefinition } from "../../lib/questions";
import { fetchDerivedPredictors, saveDerivedPredictors } from "../../lib/api";
import {
  formatMinutesAsClock,
  formatMinutesAsHours,
  formatSecondsAsHours,
} from "../../lib/time";
import type {
  AnalysisValueRecord,
  CheckInQuestion,
  DailyRecord,
  DerivedPredictorDefinition,
  MetricKey,
} from "../../lib/types";

type DensityPoint = { x: number; density: number };
type NumericAxis = { domain: [number, number]; ticks: number[] };
type CorrelationTooltipContent = {
  predictorLabel: string;
  predictorValue: string;
  outcomeLabel: string;
  outcomeValue: string;
  predictorSourceDate: string;
  outcomeSourceDate: string;
  date: string;
  sections: Array<{
    title: string;
    sourceDateLabel: string | null;
    items: Array<{ label: string; value: string }>;
  }>;
};

export interface CorrelationController {
  activeCorrelationTooltipContent: CorrelationTooltipContent | null;
  activeCorrelationTooltipStyle: { left: number; top: number } | null;
  categoricalMeanData: Array<{ x: number; xJittered: number; y: number }>;
  categoricalScatterData: Array<CorrelationPairResult["points"][number] & { xJittered: number }>;
  continuousExplorerXDomain: [number, number] | undefined;
  correlationChartRef: RefObject<HTMLDivElement | null>;
  correlationExplorerYAxis: NumericAxis | undefined;
  densityAxisTicks: number[];
  densityDomain: [number, number] | null;
  derivedBins: number;
  derivedFormError: string | null;
  derivedLabelsInput: string;
  derivedLoadState: "loading" | "ready" | "error";
  derivedMode: "threshold" | "quantile";
  derivedName: string;
  derivedPredictors: DerivedPredictorDefinition[];
  derivedSourceDensity: DensityPoint[];
  derivedSourceOptions: CorrelationOption[];
  derivedSourceSummary: { count: number; min: number | null; median: number | null; max: number | null };
  derivedSourceValues: number[];
  derivedSyncError: string | null;
  derivedThresholdInput: string;
  displayedCorrelationCards: CorrelationPairResult[];
  editingDerivedId: string | null;
  handleCorrelationPointEnter: (entry: {
    payload?: CorrelationPairResult["points"][number];
    tooltipPosition?: { x?: number; y?: number };
  }) => void;
  handleCorrelationPointLeave: MouseEventHandler;
  handleCorrelationTooltipEnter: MouseEventHandler;
  handleCorrelationTooltipLeave: MouseEventHandler;
  handleDeleteDerivedDefinition: (definitionId: string) => Promise<void>;
  handleEditDerivedDefinition: (definition: DerivedPredictorDefinition) => void;
  handleSaveDerivedDefinition: () => Promise<void>;
  inRangePreviewCutPoints: number[];
  isExploratoryFallback: boolean;
  isSavingDerived: boolean;
  outcomeKey: OutcomeKey;
  outcomeOptions: CorrelationOption[];
  outOfRangePreviewCutPoints: number[];
  predictorKey: PredictorKey;
  predictorOptions: CorrelationOption[];
  previewCutPoints: number[];
  resetDerivedForm: () => void;
  selectedCorrelationPair: CorrelationPairResult | null;
  selectedDerivedSource: BasePredictorKey;
  setDerivedBins: Dispatch<SetStateAction<number>>;
  setDerivedLabelsInput: Dispatch<SetStateAction<string>>;
  setDerivedMode: Dispatch<SetStateAction<"threshold" | "quantile">>;
  setDerivedName: Dispatch<SetStateAction<string>>;
  setDerivedThresholdInput: Dispatch<SetStateAction<string>>;
  setOutcomeKey: Dispatch<SetStateAction<OutcomeKey>>;
  setPredictorKey: Dispatch<SetStateAction<PredictorKey>>;
  setSelectedDerivedSource: Dispatch<SetStateAction<BasePredictorKey>>;
  setShowNewVariablePanel: Dispatch<SetStateAction<boolean>>;
  setTopCorrelationMode: Dispatch<SetStateAction<"target" | "predictor">>;
  showNewVariablePanel: boolean;
  topCorrelationMode: "target" | "predictor";
  topCorrelationOutcomeOptions: CorrelationOption[];
  trendLineData: Array<{ x: number; y: number }>;
  getMetricColor: (metric: MetricKey) => string;
  formatTooltipNumber: (value: number) => string;
  describeCorrelationDirection: (pair: CorrelationPairResult) => string;
}

type GarminKey =
  | "steps"
  | "calories"
  | "stressAvg"
  | "bodyBattery"
  | "runningKilometers"
  | "sleepSeconds"
  | "vo2Max"
  | "avgHr1hBeforeSleep"
  | "sleepConsistency"
  | "isTrainingDay"
  | "zone0Minutes"
  | "zone1Minutes"
  | "zone2Minutes"
  | "zone3Minutes"
  | "zone4Minutes"
  | "zone5Minutes"
  | "zone2PlusMinutes"
  | DerivedGapMetricKey;

const DEFAULT_OUTCOME: OutcomeKey = "metric:restingHr";
const GARMIN_META: Record<GarminKey, { label: string; unit: string }> = {
  steps: { label: "Steps", unit: "steps" },
  calories: { label: "Calories", unit: "kcal" },
  stressAvg: { label: "Stress Avg", unit: "pts" },
  bodyBattery: { label: "Body Battery", unit: "%" },
  runningKilometers: { label: "Running Distance", unit: "km" },
  sleepSeconds: { label: "Sleep Duration", unit: "h" },
  vo2Max: { label: "VO2 Max", unit: "ml/kg/min" },
  avgHr1hBeforeSleep: { label: "Avg HR 1h Before Sleep", unit: "bpm" },
  sleepConsistency: { label: "Sleep Consistency", unit: "min" },
  isTrainingDay: { label: "Training Day", unit: "0/1" },
  zone0Minutes: { label: "Zone 0 Time", unit: "min" },
  zone1Minutes: { label: "Zone 1 Time", unit: "min" },
  zone2Minutes: { label: "Zone 2 Time", unit: "min" },
  zone3Minutes: { label: "Zone 3 Time", unit: "min" },
  zone4Minutes: { label: "Zone 4 Time", unit: "min" },
  zone5Minutes: { label: "Zone 5 Time", unit: "min" },
  zone2PlusMinutes: { label: "Zone 2+ Time", unit: "min" },
  ...Object.fromEntries(
    DERIVED_GAP_METRICS.map((metric) => [metric.key, { label: metric.plotLabel, unit: "min" }]),
  ) as Record<DerivedGapMetricKey, { label: string; unit: string }>,
};

function metricDefinition(metric: MetricKey) {
  return METRICS.find((definition) => definition.key === metric);
}

function metricColor(metric: MetricKey): string {
  return metricDefinition(metric)?.color ?? "#cc5833";
}

function formatMetricValue(metric: MetricKey, value: number | null): string {
  if (value === null) return "--";
  const definition = metricDefinition(metric);
  return definition ? `${value.toFixed(definition.decimals)} ${definition.unit}` : String(value);
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
}

function formatHoursAsHoursMinutes(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function numericDomain(values: number[]): [number, number] | undefined {
  if (!values.length) return undefined;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return undefined;
  if (minimum !== maximum) return [minimum, maximum];
  const padding = minimum === 0 ? 1 : Math.max(Math.abs(minimum) * 0.05, 0.5);
  return [minimum - padding, maximum + padding];
}

function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  return magnitude * (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10);
}

function numericAxis(values: number[]): NumericAxis | undefined {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return undefined;
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  if (minimum === maximum) {
    const padding = minimum === 0 ? 1 : Math.max(Math.abs(minimum) * 0.05, 1);
    return { domain: [minimum - padding, maximum + padding], ticks: [minimum] };
  }
  const step = niceStep((maximum - minimum) / 4);
  const domain: [number, number] = [
    Math.floor(minimum / step) * step,
    Math.ceil(maximum / step) * step,
  ];
  const ticks: number[] = [];
  for (let value = domain[0], guard = 0; value <= domain[1] && guard < 100; value += step, guard += 1) {
    ticks.push(Number(value.toFixed(10)));
  }
  return { domain, ticks };
}

function parseCutPoints(raw: string): number[] {
  const values = raw.split(",").map((entry) => Number(entry.trim())).filter(Number.isFinite).sort((a, b) => a - b);
  return values.some((value, index) => index > 0 && value <= values[index - 1]) ? [] : values;
}

function densityCurve(values: number[], points = 80): DensityPoint[] {
  if (values.length < 2) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const minimum = sorted[0];
  const maximum = sorted.at(-1) as number;
  const span = maximum - minimum;
  if (span === 0) return [{ x: minimum, density: 1 }];
  const average = mean(sorted);
  const variance = sorted.reduce((sum, value) => sum + (value - average) ** 2, 0) / sorted.length;
  const standardDeviation = Math.sqrt(variance);
  const estimatedBandwidth = standardDeviation > 0
    ? 1.06 * standardDeviation * sorted.length ** (-0.2)
    : span / 10;
  const bandwidth = Math.max(estimatedBandwidth, span / 100, 1e-6);
  const start = minimum - span * 0.05;
  const step = (span * 1.1) / (points - 1);
  const normalizer = 1 / (sorted.length * bandwidth * Math.sqrt(2 * Math.PI));
  return Array.from({ length: points }, (_, index) => {
    const x = start + step * index;
    const sum = sorted.reduce((total, value) => total + Math.exp(-0.5 * ((x - value) / bandwidth) ** 2), 0);
    return { x, density: normalizer * sum };
  });
}

function analysisLabel(key: string, questions: Map<string, QuestionFieldDefinition>): string {
  if (key.startsWith("metric:")) return metricDefinition(key.slice(7) as MetricKey)?.label ?? key;
  if (key.startsWith("garmin:")) return GARMIN_META[key.slice(7) as GarminKey]?.label ?? key;
  if (key.startsWith("question:")) return questions.get(key.slice(9))?.prompt ?? key;
  return key;
}

function questionValue(question: QuestionFieldDefinition, value: AnalysisValueRecord): string {
  if (question.inputType === "boolean") return value.valueBool === null ? "--" : value.valueBool ? "Yes" : "No";
  if (question.inputType === "time") {
    return value.valueText ?? (typeof value.valueNum === "number" ? formatMinutesAsClock(Math.round(value.valueNum)) : "--");
  }
  if (question.inputType === "multi-choice") {
    if (value.valueText) return question.options?.find((option) => option.id === value.valueText)?.label ?? value.valueText;
    if (typeof value.valueNum === "number") return question.options?.find((option) => option.score === value.valueNum)?.label ?? formatNumber(value.valueNum);
    return "--";
  }
  if (typeof value.valueNum === "number") return formatNumber(value.valueNum);
  return value.valueText ?? "--";
}

function analysisValue(value: AnalysisValueRecord, questions: Map<string, QuestionFieldDefinition>): string {
  if (value.featureKey.startsWith("metric:")) return formatMetricValue(value.featureKey.slice(7) as MetricKey, value.valueNum);
  if (value.featureKey.startsWith("garmin:")) {
    const key = value.featureKey.slice(7) as GarminKey;
    if (key === "isTrainingDay") return value.valueBool ? "Yes" : "No";
    if (typeof value.valueNum !== "number") return "--";
    if (key === "sleepSeconds") return formatSecondsAsHours(value.valueNum);
    const formatted = key === "runningKilometers" ? value.valueNum.toFixed(1) : formatNumber(value.valueNum);
    return GARMIN_META[key]?.unit ? `${formatted} ${GARMIN_META[key].unit}` : formatted;
  }
  if (value.featureKey.startsWith("question:")) {
    const question = questions.get(value.featureKey.slice(9));
    if (question) return questionValue(question, value);
    if (value.valueText) return value.valueText;
    if (typeof value.valueNum === "number") return formatNumber(value.valueNum);
    return value.valueBool === null ? "--" : value.valueBool ? "Yes" : "No";
  }
  if (typeof value.valueNum === "number") return formatNumber(value.valueNum);
  if (value.valueBool !== null) return value.valueBool ? "Yes" : "No";
  return value.valueText ?? "--";
}

function sourceDates(values: AnalysisValueRecord[]): string | null {
  const dates = [...new Set(values.map((value) => value.sourceDate).filter(Boolean))];
  if (!dates.length) return null;
  return dates.length === 1 ? formatReadableDate(dates[0]) : `${formatReadableDate(dates[0])} - ${formatReadableDate(dates.at(-1) as string)}`;
}

function directionDescription(pair: CorrelationPairResult): string {
  if (pair.direction === "similar") return "No clear monotonic direction in this sample.";
  if (pair.testType === "categorical") return `Moving from lower to higher ${pair.predictorLabel} categories is associated with ${pair.direction} ${pair.outcomeLabel}.`;
  return `Higher ${pair.predictorLabel} is associated with ${pair.direction} ${pair.outcomeLabel}.`;
}

function boundary(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function defaultLabels(cutPoints: number[]): string[] {
  if (!cutPoints.length) return [];
  return [
    `< ${boundary(cutPoints[0])}`,
    ...cutPoints.slice(1).map((value, index) => `${boundary(cutPoints[index])} to < ${boundary(value)}`),
    `>= ${boundary(cutPoints.at(-1) as number)}`,
  ];
}

export interface CorrelationFeatureInputs {
  records: DailyRecord[];
  analysisValues: AnalysisValueRecord[];
  questions: CheckInQuestion[];
  questionLoadState: "loading" | "ready" | "error";
  predictorKey: PredictorKey;
  outcomeKey: OutcomeKey;
  setPredictorKey: Dispatch<SetStateAction<PredictorKey>>;
  setOutcomeKey: Dispatch<SetStateAction<OutcomeKey>>;
}

export function useCorrelationFeature(inputs: CorrelationFeatureInputs): CorrelationController {
  const { records, analysisValues, questions, questionLoadState, predictorKey, outcomeKey, setPredictorKey, setOutcomeKey } = inputs;
  const [topCorrelationMode, setTopCorrelationMode] = useState<"target" | "predictor">("target");
  const [activeTooltip, setActiveTooltip] = useState<{ point: CorrelationPairResult["points"][number]; position: { x: number; y: number } } | null>(null);
  const [showNewVariablePanel, setShowNewVariablePanel] = useState(false);
  const [derivedPredictors, setDerivedPredictors] = useState<DerivedPredictorDefinition[]>([]);
  const [derivedLoadState, setDerivedLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [derivedSyncError, setDerivedSyncError] = useState<string | null>(null);
  const [isSavingDerived, setIsSavingDerived] = useState(false);
  const [selectedDerivedSource, setSelectedDerivedSource] = useState<BasePredictorKey>("garmin:steps");
  const [derivedMode, setDerivedMode] = useState<"threshold" | "quantile">("threshold");
  const [derivedThresholdInput, setDerivedThresholdInput] = useState("2");
  const [derivedBins, setDerivedBins] = useState(2);
  const [derivedName, setDerivedName] = useState("");
  const [derivedLabelsInput, setDerivedLabelsInput] = useState("");
  const [editingDerivedId, setEditingDerivedId] = useState<string | null>(null);
  const [derivedFormError, setDerivedFormError] = useState<string | null>(null);
  const correlationChartRef = useRef<HTMLDivElement | null>(null);
  const hideTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDerivedLoadState("loading");
    setDerivedSyncError(null);
    void fetchDerivedPredictors(controller.signal)
      .then((payload) => {
        setDerivedPredictors(payload.definitions);
        setDerivedLoadState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDerivedSyncError(error instanceof Error ? error.message : "Failed to load derived predictors.");
        setDerivedLoadState("error");
      });
    return () => controller.abort();
  }, []);

  const persistDefinitions = useCallback(async (definitions: DerivedPredictorDefinition[]) => {
    setIsSavingDerived(true);
    setDerivedSyncError(null);
    try {
      const payload = await saveDerivedPredictors(definitions);
      setDerivedPredictors(payload.definitions);
    } catch (error) {
      setDerivedSyncError(error instanceof Error ? error.message : "Failed to save derived predictors.");
      throw error;
    } finally {
      setIsSavingDerived(false);
    }
  }, []);

  const questionFields = useMemo(() => flattenQuestionFields(questions), [questions]);
  const questionsById = useMemo(() => new Map(questionFields.map((field) => [field.id, field])), [questionFields]);
  const recordsByDate = useMemo(() => new Map(records.map((record) => [record.date, record])), [records]);
  const detailsByDate = useMemo(() => {
    const grouped = new Map<string, { predictor: AnalysisValueRecord[]; target: AnalysisValueRecord[] }>();
    for (const value of analysisValues) {
      const bucket = grouped.get(value.analysisDate) ?? { predictor: [], target: [] };
      bucket[value.role === "predictor" ? "predictor" : "target"].push(value);
      grouped.set(value.analysisDate, bucket);
    }
    for (const bucket of grouped.values()) {
      const byLabel = (a: AnalysisValueRecord, b: AnalysisValueRecord) => analysisLabel(a.featureKey, questionsById).localeCompare(analysisLabel(b.featureKey, questionsById));
      bucket.predictor.sort(byLabel);
      bucket.target.sort(byLabel);
    }
    return grouped;
  }, [analysisValues, questionsById]);
  const predictorOptions = useMemo(() => buildPredictorOptions(questions, derivedPredictors), [derivedPredictors, questions]);
  const derivedSourceOptions = useMemo(() => buildDerivedPredictorSourceOptions(questions), [questions]);
  const outcomeOptions = useMemo(() => buildOutcomeOptions(questions), [questions]);

  useEffect(() => {
    if (predictorOptions.some((option) => option.key === predictorKey) || !predictorOptions.length) return;
    if ((predictorKey.startsWith("question:") && questionLoadState === "loading") || (predictorKey.startsWith("derived:") && derivedLoadState === "loading")) return;
    setPredictorKey(predictorOptions[0].key as PredictorKey);
  }, [derivedLoadState, predictorKey, predictorOptions, questionLoadState, setPredictorKey]);
  useEffect(() => {
    if (outcomeOptions.some((option) => option.key === outcomeKey) || !outcomeOptions.length) return;
    if (outcomeKey.startsWith("question:") && questionLoadState === "loading") return;
    setOutcomeKey((outcomeOptions.find((option) => option.key === DEFAULT_OUTCOME)?.key ?? outcomeOptions[0].key) as OutcomeKey);
  }, [outcomeKey, outcomeOptions, questionLoadState, setOutcomeKey]);
  useEffect(() => {
    if (derivedSourceOptions.length && !derivedSourceOptions.some((option) => option.key === selectedDerivedSource)) {
      setSelectedDerivedSource(derivedSourceOptions[0].key as BasePredictorKey);
    }
  }, [derivedSourceOptions, selectedDerivedSource]);

  const catalog = useMemo(() => buildCorrelationCatalog({ records, analysisValues, questions, derivedPredictors, weekdayOnly: false, trainingOnly: false }), [analysisValues, derivedPredictors, questions, records]);
  const selectedCorrelationPair = useMemo(() => findCorrelationPair(catalog, predictorKey, outcomeKey), [catalog, outcomeKey, predictorKey]);
  const eligibleCatalog = useMemo(() => catalog.filter((pair) => outcomeOptions.some((option) => option.key === pair.outcome)), [catalog, outcomeOptions]);
  const meaningful = eligibleCatalog.filter((pair) => pair.classification === "meaningful" && (topCorrelationMode === "target" ? pair.outcome === outcomeKey : pair.predictor === predictorKey));
  const exploratory = eligibleCatalog.filter((pair) => pair.classification === "exploratory" && (topCorrelationMode === "target" ? pair.outcome === outcomeKey : pair.predictor === predictorKey));
  const displayedCorrelationCards = meaningful.length ? meaningful : exploratory;
  const isExploratoryFallback = !meaningful.length && Boolean(exploratory.length);
  const continuousExplorerXDomain = selectedCorrelationPair?.testType === "continuous" ? numericDomain(selectedCorrelationPair.points.map((point) => point.x)) : undefined;
  const trendLineData = useMemo(() => {
    if (selectedCorrelationPair?.testType !== "continuous" || !selectedCorrelationPair.regression || selectedCorrelationPair.points.length < 2) return [];
    const xs = selectedCorrelationPair.points.map((point) => point.x);
    return [Math.min(...xs), Math.max(...xs)].map((x) => ({ x, y: selectedCorrelationPair.regression!.slope * x + selectedCorrelationPair.regression!.intercept }));
  }, [selectedCorrelationPair]);
  const correlationExplorerYAxis = selectedCorrelationPair ? numericAxis([...selectedCorrelationPair.points.map((point) => point.y), ...trendLineData.map((point) => point.y)]) : undefined;
  const categoricalScatterData = selectedCorrelationPair?.testType === "categorical" ? selectedCorrelationPair.points.map((point, index) => ({ ...point, xJittered: point.x + ((((index * 37) % 100) / 100) - 0.5) * 0.35 })) : [];
  const categoricalMeanData = selectedCorrelationPair?.testType === "categorical" ? (selectedCorrelationPair.categoryMeans ?? []).map((y, x) => y === null ? null : ({ x, xJittered: x, y })).filter((point): point is { x: number; xJittered: number; y: number } => point !== null) : [];

  const clearHideTimeout = useCallback(() => {
    if (hideTimeoutRef.current !== null) window.clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = null;
  }, []);
  const handleCorrelationTooltipEnter = clearHideTimeout;
  const handleCorrelationTooltipLeave = useCallback(() => {
    clearHideTimeout();
    hideTimeoutRef.current = window.setTimeout(() => setActiveTooltip(null), 180);
  }, [clearHideTimeout]);
  const handleCorrelationPointEnter = useCallback((entry: { payload?: CorrelationPairResult["points"][number]; tooltipPosition?: { x?: number; y?: number } }) => {
    clearHideTimeout();
    if (!entry.payload || typeof entry.tooltipPosition?.x !== "number" || typeof entry.tooltipPosition.y !== "number") return;
    setActiveTooltip({ point: entry.payload, position: { x: entry.tooltipPosition.x, y: entry.tooltipPosition.y } });
  }, [clearHideTimeout]);
  const handleCorrelationPointLeave = handleCorrelationTooltipLeave;
  useEffect(() => () => clearHideTimeout(), [clearHideTimeout]);
  useEffect(() => {
    clearHideTimeout();
    setActiveTooltip(null);
  }, [clearHideTimeout, outcomeKey, predictorKey, selectedCorrelationPair]);

  const activeCorrelationTooltipContent = useMemo<CorrelationTooltipContent | null>(() => {
    if (!activeTooltip) return null;
    const details = detailsByDate.get(activeTooltip.point.date);
    let predictorItems = (details?.predictor ?? []).map((value) => ({ label: analysisLabel(value.featureKey, questionsById), value: analysisValue(value, questionsById) }));
    const record = recordsByDate.get(activeTooltip.point.date);
    if (record) {
      for (const metric of DERIVED_GAP_METRICS) {
        const value = record.predictors[metric.key];
        if (typeof value === "number" && !predictorItems.some((item) => item.label === metric.tooltipLabel)) predictorItems.push({ label: metric.tooltipLabel, value: formatMinutesAsHours(value) });
      }
    }
    const sections = [
      { title: "Predictor context", sourceDateLabel: sourceDates(details?.predictor ?? []), items: predictorItems },
      { title: "Outcome context", sourceDateLabel: sourceDates(details?.target ?? []), items: (details?.target ?? []).map((value) => ({ label: analysisLabel(value.featureKey, questionsById), value: analysisValue(value, questionsById) })) },
    ].filter((section) => section.items.length);
    const predictorValue = selectedCorrelationPair?.testType === "categorical" ? selectedCorrelationPair.categoryLabels?.[Math.round(activeTooltip.point.x)] ?? formatNumber(activeTooltip.point.x) : predictorKey === "garmin:sleepSeconds" ? formatHoursAsHoursMinutes(activeTooltip.point.x) : predictorKey.startsWith("garmin:") && DERIVED_GAP_METRIC_KEYS.has(predictorKey.slice(7) as DerivedGapMetricKey) ? formatMinutesAsHours(Math.round(activeTooltip.point.x)) : formatNumber(activeTooltip.point.x);
    return {
      predictorLabel: getOptionLabel(predictorOptions, predictorKey, predictorKey),
      predictorValue,
      outcomeLabel: getOptionLabel(outcomeOptions, outcomeKey, outcomeKey),
      outcomeValue: outcomeKey.startsWith("metric:") ? formatMetricValue(outcomeKey.slice(7) as MetricKey, activeTooltip.point.y) : formatNumber(activeTooltip.point.y),
      predictorSourceDate: activeTooltip.point.predictorSourceDate,
      outcomeSourceDate: activeTooltip.point.outcomeSourceDate,
      date: activeTooltip.point.date,
      sections,
    };
  }, [activeTooltip, detailsByDate, outcomeKey, outcomeOptions, predictorKey, predictorOptions, questionsById, recordsByDate, selectedCorrelationPair]);
  const activeCorrelationTooltipStyle = useMemo(() => {
    if (!activeTooltip) return null;
    const width = correlationChartRef.current?.clientWidth ?? 0;
    const height = correlationChartRef.current?.clientHeight ?? 0;
    let left = activeTooltip.position.x + 14;
    let top = activeTooltip.position.y + 14;
    if (width && left + 384 > width - 8) left = Math.max(8, activeTooltip.position.x - 398);
    if (height && top + 416 > height - 8) top = Math.max(8, height - 424);
    return { left, top };
  }, [activeTooltip]);

  const derivedSourceValues = useMemo(() => buildPredictorDistribution({ records, analysisValues, questions, predictor: selectedDerivedSource, weekdayOnly: false, trainingOnly: false }), [analysisValues, questions, records, selectedDerivedSource]);
  const derivedSourceDensity = useMemo(() => densityCurve(derivedSourceValues), [derivedSourceValues]);
  const previewCutPoints = useMemo(() => derivedMode === "threshold" ? parseCutPoints(derivedThresholdInput) : calculateQuantileCutPoints(derivedSourceValues, derivedBins), [derivedBins, derivedMode, derivedSourceValues, derivedThresholdInput]);
  const derivedSourceSummary = useMemo(() => {
    if (!derivedSourceValues.length) return { count: 0, min: null, median: null, max: null };
    const sorted = [...derivedSourceValues].sort((a, b) => a - b);
    const center = Math.floor(sorted.length / 2);
    return { count: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[center] : (sorted[center - 1] + sorted[center]) / 2, max: sorted.at(-1) as number };
  }, [derivedSourceValues]);
  const inRangePreviewCutPoints = derivedSourceSummary.min === null ? [] : previewCutPoints.filter((value) => value >= derivedSourceSummary.min! && value <= derivedSourceSummary.max!);
  const outOfRangePreviewCutPoints = derivedSourceSummary.min === null ? previewCutPoints : previewCutPoints.filter((value) => value < derivedSourceSummary.min! || value > derivedSourceSummary.max!);
  const densityDomain = useMemo<[number, number] | null>(() => {
    if (!derivedSourceDensity.length) return null;
    const xs = derivedSourceDensity.map((point) => point.x);
    const minimum = Math.min(...xs);
    const maximum = Math.max(...xs);
    if (minimum === maximum) return [minimum - 1, maximum + 1];
    const padding = (maximum - minimum) * 0.05;
    return [minimum - padding, maximum + padding];
  }, [derivedSourceDensity]);
  const densityStep = densityDomain ? [1, 5, 10, 50, 100, 1000].find((step) => (densityDomain[1] - densityDomain[0]) / step <= 10) ?? 1000 : 1;
  const densityAxisTicks = useMemo(() => {
    if (!densityDomain) return [];
    const ticks: number[] = [];
    for (let value = Math.floor(densityDomain[0] / densityStep) * densityStep; value <= Math.ceil(densityDomain[1] / densityStep) * densityStep && ticks.length < 500; value += densityStep) ticks.push(Math.round(value));
    return ticks;
  }, [densityDomain, densityStep]);

  const resetDerivedForm = useCallback(() => {
    setEditingDerivedId(null); setDerivedName(""); setDerivedThresholdInput("2"); setDerivedLabelsInput(""); setDerivedBins(2); setDerivedMode("threshold"); setDerivedFormError(null);
  }, []);
  const handleSaveDerivedDefinition = useCallback(async () => {
    const name = derivedName.trim();
    if (!name) return setDerivedFormError("Name is required.");
    const cutPoints = derivedMode === "threshold" ? parseCutPoints(derivedThresholdInput) : calculateQuantileCutPoints(derivedSourceValues, derivedBins);
    if (!cutPoints.length) return setDerivedFormError("Unable to compute valid cut points for this source.");
    const customLabels = derivedLabelsInput.split(",").map((label) => label.trim()).filter(Boolean);
    const labels = customLabels.length ? customLabels : defaultLabels(cutPoints);
    if (labels.length !== cutPoints.length + 1) return setDerivedFormError(`Expected ${cutPoints.length + 1} labels for ${cutPoints.length + 1} bins.`);
    const definition: DerivedPredictorDefinition = { id: editingDerivedId ?? `derived_${Date.now()}`, name, sourceKey: selectedDerivedSource, mode: derivedMode, cutPoints, labels };
    const definitions = editingDerivedId ? derivedPredictors.map((item) => item.id === editingDerivedId ? definition : item) : [...derivedPredictors, definition];
    setDerivedFormError(null);
    try { await persistDefinitions(definitions); resetDerivedForm(); } catch { /* surfaced by persistDefinitions */ }
  }, [derivedBins, derivedLabelsInput, derivedMode, derivedName, derivedPredictors, derivedSourceValues, derivedThresholdInput, editingDerivedId, persistDefinitions, resetDerivedForm, selectedDerivedSource]);
  const handleEditDerivedDefinition = useCallback((definition: DerivedPredictorDefinition) => {
    setEditingDerivedId(definition.id); setDerivedName(definition.name); setSelectedDerivedSource(definition.sourceKey as BasePredictorKey); setDerivedMode(definition.mode); setDerivedThresholdInput(definition.cutPoints.join(", ")); setDerivedBins(Math.max(2, Math.min(5, definition.labels.length))); setDerivedLabelsInput(definition.labels.join(", ")); setDerivedFormError(null);
  }, []);
  const handleDeleteDerivedDefinition = useCallback(async (id: string) => {
    try { await persistDefinitions(derivedPredictors.filter((definition) => definition.id !== id)); if (editingDerivedId === id) resetDerivedForm(); } catch { /* surfaced by persistDefinitions */ }
  }, [derivedPredictors, editingDerivedId, persistDefinitions, resetDerivedForm]);

  return {
    activeCorrelationTooltipContent, activeCorrelationTooltipStyle, categoricalMeanData, categoricalScatterData,
    continuousExplorerXDomain, correlationChartRef, correlationExplorerYAxis, densityAxisTicks, densityDomain,
    derivedBins, derivedFormError, derivedLabelsInput, derivedLoadState, derivedMode, derivedName, derivedPredictors,
    derivedSourceDensity, derivedSourceOptions, derivedSourceSummary, derivedSourceValues, derivedSyncError,
    derivedThresholdInput, displayedCorrelationCards, editingDerivedId, handleCorrelationPointEnter,
    handleCorrelationPointLeave, handleCorrelationTooltipEnter, handleCorrelationTooltipLeave,
    handleDeleteDerivedDefinition, handleEditDerivedDefinition, handleSaveDerivedDefinition,
    inRangePreviewCutPoints, isExploratoryFallback, isSavingDerived, outcomeKey, outcomeOptions,
    outOfRangePreviewCutPoints, predictorKey, predictorOptions, previewCutPoints, resetDerivedForm,
    selectedCorrelationPair, selectedDerivedSource, setDerivedBins, setDerivedLabelsInput, setDerivedMode,
    setDerivedName, setDerivedThresholdInput, setOutcomeKey, setPredictorKey, setSelectedDerivedSource,
    setShowNewVariablePanel, setTopCorrelationMode, showNewVariablePanel, topCorrelationMode,
    topCorrelationOutcomeOptions: outcomeOptions, trendLineData, getMetricColor: metricColor,
    formatTooltipNumber: formatNumber, describeCorrelationDirection: directionDescription,
  };
}
