import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { METRICS } from "../../lib/constants";
import {
  buildExploreTogetherResult,
  type CorrelationOption,
  type OutcomeKey,
  type PredictorKey,
} from "../../lib/correlation";
import { flattenQuestionFields } from "../../lib/questions";
import { formatMinutesAsClock } from "../../lib/time";
import type {
  AnalysisValueRecord,
  CheckInQuestion,
  DailyRecord,
  DerivedPredictorDefinition,
} from "../../lib/types";

type Props = {
  records: DailyRecord[];
  analysisValues: AnalysisValueRecord[];
  questions: CheckInQuestion[];
  derivedPredictors: DerivedPredictorDefinition[];
  predictorOptions: CorrelationOption[];
  outcomeOptions: CorrelationOption[];
};

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCorrelation(value: number | null): string {
  return value === null ? "—" : `r = ${value.toFixed(2)}`;
}

export function ExploreTogether({
  records, analysisValues, questions, derivedPredictors, predictorOptions, outcomeOptions,
}: Props) {
  const [predictorA, setPredictorA] = useState<PredictorKey>("question:caffeine_count");
  const [predictorB, setPredictorB] = useState<PredictorKey>("question:alcohol_units");
  const [outcome, setOutcome] = useState<OutcomeKey>("metric:sleepScore");
  const fields = useMemo(() => new Map(flattenQuestionFields(questions).map((field) => [field.id, field])), [questions]);
  const numericPredictors = useMemo(() => predictorOptions.filter((option) => {
    if (!option.key.startsWith("question:")) return true;
    const field = fields.get(option.key.slice(9));
    return field?.inputType !== "multi-choice" || field.options?.every((choice) => Number.isFinite(choice.score)) === true;
  }), [fields, predictorOptions]);
  const numericOutcomes = useMemo(() => outcomeOptions.filter((option) => {
    if (!option.key.startsWith("question:")) return true;
    const field = fields.get(option.key.slice(9));
    return field?.inputType === "slider" || field?.inputType === "time"
      || (field?.inputType === "multi-choice" && field.options?.every((choice) => Number.isFinite(choice.score)));
  }), [fields, outcomeOptions]);

  useEffect(() => {
    const keys = new Set(numericPredictors.map((option) => option.key));
    if (!keys.has(predictorA) && numericPredictors[0]) setPredictorA(numericPredictors[0].key as PredictorKey);
    const alternate = numericPredictors.find((option) => option.key !== predictorA);
    if ((!keys.has(predictorB) || predictorA === predictorB) && alternate) setPredictorB(alternate.key as PredictorKey);
  }, [numericPredictors, predictorA, predictorB]);
  useEffect(() => {
    if (!numericOutcomes.some((option) => option.key === outcome) && numericOutcomes[0]) setOutcome(numericOutcomes[0].key as OutcomeKey);
  }, [numericOutcomes, outcome]);

  const result = useMemo(() => {
    if (!numericPredictors.some((option) => option.key === predictorA)
      || !numericPredictors.some((option) => option.key === predictorB)
      || !numericOutcomes.some((option) => option.key === outcome)) return null;
    return buildExploreTogetherResult({
      records, analysisValues, questions, derivedPredictors, predictorA, predictorB, outcome,
    });
  }, [analysisValues, derivedPredictors, numericOutcomes, numericPredictors, outcome, predictorA, predictorB, questions, records]);
  const label = (key: string, options: CorrelationOption[]): string => options.find((option) => option.key === key)?.label ?? key;
  const labelA = label(predictorA, numericPredictors);
  const labelB = label(predictorB, numericPredictors);
  const labelY = label(outcome, numericOutcomes);
  const unit = outcome.startsWith("metric:")
    ? METRICS.find((metric) => metric.key === outcome.slice(7))?.unit ?? ""
    : "";
  const formatPredictor = (key: PredictorKey, value: number): string => {
    if (key.startsWith("derived:")) {
      return derivedPredictors.find((definition) => definition.id === key.slice(8))?.labels[Math.round(value)] ?? formatNumber(value);
    }
    if (key === "garmin:isTrainingDay" || fields.get(key.slice(9))?.inputType === "boolean") {
      return value === 0 ? "No" : "Yes";
    }
    const field = key.startsWith("question:") ? fields.get(key.slice(9)) : null;
    if (field?.inputType === "time") return formatMinutesAsClock(Math.round(value));
    if (field?.inputType === "multi-choice") {
      return field.options?.find((choice) => choice.score === value)?.label ?? formatNumber(value);
    }
    return formatNumber(value);
  };
  const interaction = result?.interaction;
  const chart = interaction ? [
    { level: formatPredictor(predictorA, interaction.aLow), lower: interaction.lowBEstimates[0], higher: interaction.highBEstimates[0] },
    { level: formatPredictor(predictorA, interaction.aHigh), lower: interaction.lowBEstimates[1], higher: interaction.highBEstimates[1] },
  ] : [];
  const lowBLabel = interaction ? `${labelB}: ${formatPredictor(predictorB, interaction.bLow)}` : "";
  const highBLabel = interaction ? `${labelB}: ${formatPredictor(predictorB, interaction.bHigh)}` : "";

  return (
    <div className="space-y-4">
      <article className="panel p-6 sm:p-8">
        <h3 className="text-lg font-semibold tracking-tight">Explore Together</h3>
        <p className="mt-1 text-sm text-muted">Compare two predictors individually, then see how their relationship with the target changes together.</p>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase tracking-[0.16em] text-muted">Predictor A</span>
            <select className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3" value={predictorA} onChange={(event) => setPredictorA(event.target.value as PredictorKey)}>
              {numericPredictors.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase tracking-[0.16em] text-muted">Predictor B</span>
            <select className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3" value={predictorB} onChange={(event) => setPredictorB(event.target.value as PredictorKey)}>
              {numericPredictors.filter((option) => option.key !== predictorA).map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase tracking-[0.16em] text-muted">Target</span>
            <select className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3" value={outcome} onChange={(event) => setOutcome(event.target.value as OutcomeKey)}>
              {numericOutcomes.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <p className="mt-4 text-xs text-muted">{result?.sampleCount ?? 0} days with all three values · existing predictor and target alignment</p>
      </article>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="panel p-6 sm:p-8">
          <h3 className="text-lg font-semibold tracking-tight">Individual relationships</h3>
          <p className="mt-1 text-sm text-muted">Each predictor is compared with {labelY} on the same complete days.</p>
          <div className="mt-5 space-y-3">
            {[
              { key: "a", name: labelA, correlation: result?.correlationA ?? null },
              { key: "b", name: labelB, correlation: result?.correlationB ?? null },
            ].map(({ key, name, correlation }) => (
              <div key={key} className="flex items-center justify-between gap-3 rounded-2xl bg-subsurface px-4 py-3">
                <span className="text-sm font-medium">{name}</span>
                <span className="metric-number text-sm font-semibold">{formatCorrelation(correlation)}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted">Pearson r describes each relationship separately; it does not account for the other predictor.</p>
        </article>

        <article className="panel p-6 sm:p-8">
          <h3 className="text-lg font-semibold tracking-tight">Interaction</h3>
          {interaction ? (
            <>
              <p className="mt-1 text-sm text-muted">Estimated {labelY} across lower and higher {labelB} values.</p>
              <div className="mt-4 h-64" role="img" aria-label={`Estimated ${labelY} by ${labelA} at lower and higher ${labelB} values`}>
                <ResponsiveContainer>
                  <LineChart data={chart} margin={{ top: 8, right: 14, left: 4, bottom: 8 }}>
                    <CartesianGrid stroke="rgba(18,18,18,0.08)" strokeDasharray="3 6" />
                    <XAxis dataKey="level" tick={{ fontSize: 12 }} label={{ value: labelA, position: "insideBottom", offset: -4, fontSize: 12 }} />
                    <YAxis width={42} tick={{ fontSize: 12 }} tickFormatter={formatNumber} />
                    <Tooltip formatter={(value, name) => [`${formatNumber(Number(value))}${unit ? ` ${unit}` : ""}`, name]} />
                    <Line dataKey="lower" name={lowBLabel} stroke="#3f6686" strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
                    <Line dataKey="higher" name={highBLabel} stroke="#CC5833" strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span><span className="mr-1 inline-block size-2 rounded-full bg-[#3f6686]" />{lowBLabel} ({interaction.lowBCount} days at or below)</span>
                <span><span className="mr-1 inline-block size-2 rounded-full bg-[#CC5833]" />{highBLabel} ({interaction.highBCount} days at or above)</span>
              </div>
              <p className="mt-4 rounded-2xl bg-subsurface px-4 py-3 text-sm">
                Difference in the {labelA} relationship between higher and lower {labelB}: <strong className="metric-number">{interaction.difference > 0 ? "+" : ""}{formatNumber(interaction.difference)}{unit ? ` ${unit}` : ""}</strong>.
              </p>
              <p className="mt-3 text-xs text-muted">
                {interaction.interval
                  ? `Approximate 95% interval: ${formatNumber(interaction.interval[0])} to ${formatNumber(interaction.interval[1])}${unit ? ` ${unit}` : ""} (weekly block resampling).`
                  : "An uncertainty interval is unavailable for this selection."}
                {" "}Observational association; it does not establish causality.
              </p>
            </>
          ) : (
            <p className="mt-4 rounded-2xl bg-subsurface px-4 py-3 text-sm text-muted">{result?.reason ?? "Choose two predictors and a target to begin."}</p>
          )}
        </article>
      </div>
    </div>
  );
}
