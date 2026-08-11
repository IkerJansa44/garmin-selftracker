import clsx from "clsx";
import { LoaderCircle } from "lucide-react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatReadableDate } from "../../lib/mockData";
import {
  getOptionLabel,
  type BasePredictorKey,
  type OutcomeKey,
  type PredictorKey,
} from "../../lib/correlation";
import type { MetricKey } from "../../lib/types";
import type { CorrelationController } from "./useCorrelationFeature";

export function CorrelationFeature({ controller }: { controller: CorrelationController }) {
  const {
    activeCorrelationTooltipContent,
    activeCorrelationTooltipStyle,
    categoricalMeanData,
    categoricalScatterData,
    continuousExplorerXDomain,
    correlationChartRef,
    correlationExplorerYAxis,
    densityAxisTicks,
    densityDomain,
    derivedBins,
    derivedFormError,
    derivedLabelsInput,
    derivedLoadState,
    derivedMode,
    derivedName,
    derivedPredictors,
    derivedSourceDensity,
    derivedSourceOptions,
    derivedSourceSummary,
    derivedSourceValues,
    derivedSyncError,
    derivedThresholdInput,
    displayedCorrelationCards,
    editingDerivedId,
    getMetricColor,
    handleCorrelationPointEnter,
    handleCorrelationPointLeave,
    handleCorrelationTooltipEnter,
    handleCorrelationTooltipLeave,
    handleDeleteDerivedDefinition,
    handleEditDerivedDefinition,
    handleSaveDerivedDefinition,
    inRangePreviewCutPoints,
    isExploratoryFallback,
    isSavingDerived,
    outcomeKey,
    outcomeOptions,
    outOfRangePreviewCutPoints,
    predictorKey,
    predictorOptions,
    previewCutPoints,
    resetDerivedForm,
    selectedCorrelationPair,
    selectedDerivedSource,
    setDerivedBins,
    setDerivedLabelsInput,
    setDerivedMode,
    setDerivedName,
    setDerivedThresholdInput,
    setOutcomeKey,
    setPredictorKey,
    setSelectedDerivedSource,
    setShowNewVariablePanel,
    setTopCorrelationMode,
    showNewVariablePanel,
    topCorrelationMode,
    topCorrelationOutcomeOptions,
    trendLineData,
    formatTooltipNumber,
    describeCorrelationDirection,
  } = controller;
  return (
          <section className="gsap-fade space-y-5">
            <article className="panel p-6 sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">Correlation Lab</h2>
                  <p className="mt-1 text-sm text-muted">
                    Univariate associations only. Predictors can correlate with each other, so results are directional signals, not causality.
                  </p>
                </div>
                <button
                  className="focusable min-h-11 rounded-capsule bg-accent px-5 text-sm font-semibold text-white shadow-soft"
                  type="button"
                  onClick={() => setShowNewVariablePanel((previous) => !previous)}
                >
                  + New Variable
                </button>
              </div>
            </article>

            {showNewVariablePanel && (
              <article className="panel p-6 sm:p-8">
              <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">Derived Predictors</h3>
                  <p className="text-sm text-muted">
                    Build threshold or quantile bins from continuous predictors. Definitions are persisted in SQLite settings.
                  </p>
                </div>
                {isSavingDerived && (
                  <span className="inline-flex items-center gap-2 text-sm text-muted">
                    <LoaderCircle className="size-4 animate-spin" />
                    Saving...
                  </span>
                )}
              </header>
              {derivedSyncError && (
                <p className="mb-3 rounded-2xl bg-[color-mix(in_srgb,var(--error)_14%,white)] px-3 py-2 text-sm text-error">
                  {derivedSyncError}
                </p>
              )}
              <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
                <div className="space-y-3 rounded-[22px] bg-subsurface p-4">
                  <label className="space-y-2 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Source Predictor</span>
                    <select
                      className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                      value={selectedDerivedSource}
                      onChange={(event) => setSelectedDerivedSource(event.target.value as BasePredictorKey)}
                    >
                      {derivedSourceOptions.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span className="block text-xs uppercase tracking-[0.16em] text-muted">Mode</span>
                      <select
                        className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                        value={derivedMode}
                        onChange={(event) => setDerivedMode(event.target.value as "threshold" | "quantile")}
                      >
                        <option value="threshold">Threshold</option>
                        <option value="quantile">Quantile</option>
                      </select>
                    </label>
                    {derivedMode === "quantile" ? (
                      <label className="space-y-2 text-sm">
                        <span className="block text-xs uppercase tracking-[0.16em] text-muted">Bins (2-5)</span>
                        <input
                          className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                          max={5}
                          min={2}
                          type="number"
                          value={derivedBins}
                          onChange={(event) => setDerivedBins(Math.max(2, Math.min(5, Number(event.target.value) || 2)))}
                        />
                      </label>
                    ) : (
                      <label className="space-y-2 text-sm">
                        <span className="block text-xs uppercase tracking-[0.16em] text-muted">Cut Points</span>
                        <input
                          className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                          placeholder="e.g. 2, 4"
                          type="text"
                          value={derivedThresholdInput}
                          onChange={(event) => setDerivedThresholdInput(event.target.value)}
                        />
                      </label>
                    )}
                  </div>
                  <label className="space-y-2 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Name</span>
                    <input
                      className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                      placeholder="e.g. Caffeine High/Low"
                      type="text"
                      value={derivedName}
                      onChange={(event) => setDerivedName(event.target.value)}
                    />
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Labels (optional)</span>
                    <input
                      className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                      placeholder="Comma-separated labels"
                      type="text"
                      value={derivedLabelsInput}
                      onChange={(event) => setDerivedLabelsInput(event.target.value)}
                    />
                  </label>
                  {derivedFormError && (
                    <p className="rounded-2xl bg-[color-mix(in_srgb,var(--error)_14%,white)] px-3 py-2 text-sm text-error">
                      {derivedFormError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="focusable min-h-11 rounded-capsule bg-accent px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={derivedLoadState !== "ready" || !derivedSourceValues.length || isSavingDerived}
                      type="button"
                      onClick={() => void handleSaveDerivedDefinition()}
                    >
                      {editingDerivedId ? "Update definition" : "Create definition"}
                    </button>
                    <button
                      className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm font-semibold shadow-soft"
                      type="button"
                      onClick={resetDerivedForm}
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <div className="space-y-3 rounded-[22px] bg-subsurface p-4">
                  <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">Distribution Preview</h4>
                  <p className="metric-number text-xs text-muted">
                    N={derivedSourceSummary.count}
                    {derivedSourceSummary.min !== null && (
                      <> · min={derivedSourceSummary.min.toFixed(1)} · median={derivedSourceSummary.median?.toFixed(1)} · max={derivedSourceSummary.max?.toFixed(1)}</>
                    )}
                  </p>
                  {derivedSourceDensity.length ? (
                    <div className="h-44 rounded-2xl bg-panel p-2">
                      <ResponsiveContainer>
                        <ComposedChart data={derivedSourceDensity}>
                          <CartesianGrid stroke="rgba(18,18,18,0.06)" strokeDasharray="3 6" />
                          <XAxis
                            axisLine={false}
                            dataKey="x"
                            domain={
                              densityAxisTicks.length >= 2
                                ? [densityAxisTicks[0], densityAxisTicks[densityAxisTicks.length - 1]]
                                : densityDomain ?? ["auto", "auto"]
                            }
                            interval={0}
                            scale="linear"
                            ticks={densityAxisTicks}
                            tick={{ fontSize: 11 }}
                            tickFormatter={(value: number) => String(Math.round(value))}
                            tickLine={false}
                            type="number"
                          />
                          <YAxis axisLine={false} dataKey="density" hide tickLine={false} type="number" />
                          <Tooltip
                            cursor={{ strokeDasharray: "3 4" }}
                            formatter={(value, key) => [
                              key === "density" ? Number(value).toFixed(4) : Number(value).toFixed(2),
                              key,
                            ]}
                            labelFormatter={(label) => `x=${Number(label).toFixed(2)}`}
                          />
                          <Line
                            dataKey="density"
                            dot={false}
                            stroke="#CC5833"
                            strokeWidth={2}
                            type="monotone"
                          />
                          {inRangePreviewCutPoints.map((cutPoint, index) => (
                            <ReferenceLine
                              key={`${cutPoint}-${index}`}
                              ifOverflow="extendDomain"
                              label={{ value: `C${index + 1}`, fill: "#cc5833", fontSize: 10 }}
                              stroke="#CC5833"
                              strokeDasharray="4 4"
                              x={cutPoint}
                            />
                          ))}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">No values available for this source.</p>
                  )}
                  <p className="metric-number text-xs text-muted">
                    Cut points: {previewCutPoints.length ? previewCutPoints.map((value) => value.toFixed(2)).join(", ") : "--"}
                  </p>
                  {outOfRangePreviewCutPoints.length > 0 && (
                    <p className="metric-number text-xs text-warning">
                      Out of range: {outOfRangePreviewCutPoints.map((value) => value.toFixed(2)).join(", ")}
                    </p>
                  )}

                  <div className="pt-2">
                    <h4 className="mb-2 text-sm font-semibold uppercase tracking-[0.16em] text-muted">Saved Definitions</h4>
                    <div className="space-y-2">
                      {derivedPredictors.length ? derivedPredictors.map((definition) => (
                        <div key={definition.id} className="rounded-2xl bg-panel p-3">
                          <p className="text-sm font-semibold">{definition.name}</p>
                          <p className="mt-1 text-xs text-muted">
                            {getOptionLabel(derivedSourceOptions, definition.sourceKey, definition.sourceKey)}
                            {" · "}
                            {definition.mode}
                            {" · "}
                            {definition.labels.length} bins
                          </p>
                          <div className="mt-2 flex gap-2">
                            <button
                              className="focusable rounded-capsule bg-subsurface px-3 py-1 text-xs font-semibold"
                              type="button"
                              onClick={() => handleEditDerivedDefinition(definition)}
                            >
                              Edit
                            </button>
                            <button
                              className="focusable rounded-capsule bg-[color-mix(in_srgb,var(--error)_14%,white)] px-3 py-1 text-xs font-semibold text-error"
                              type="button"
                              onClick={() => void handleDeleteDerivedDefinition(definition.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )) : (
                        <p className="text-sm text-muted">No derived predictors yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              </article>
            )}

            <article className="panel p-4 sm:p-8">
              <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">Top Correlations</h3>
                  <p className="text-sm text-muted">
                    Predictor values are aligned to the previous day. Outcomes are measured on the selected day.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex rounded-capsule bg-subsurface p-1">
                    {(["target", "predictor"] as const).map((mode) => (
                      <button
                        key={mode}
                        className={clsx(
                          "focusable min-h-10 rounded-capsule px-4 text-sm font-semibold transition",
                          topCorrelationMode === mode ? "bg-accent text-white" : "text-muted hover:text-ink",
                        )}
                        type="button"
                        onClick={() => setTopCorrelationMode(mode)}
                      >
                        {mode === "target" ? "By target" : "By predictor"}
                      </button>
                    ))}
                  </div>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">
                      {topCorrelationMode === "target" ? "Target variable" : "Predictor variable"}
                    </span>
                    {topCorrelationMode === "target" ? (
                      <select
                        className="focusable min-h-11 rounded-2xl bg-subsurface px-3"
                        value={outcomeKey}
                        onChange={(event) => setOutcomeKey(event.target.value as OutcomeKey)}
                      >
                        {topCorrelationOutcomeOptions.map((option) => (
                          <option key={option.key} value={option.key}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                      <select
                        className="focusable min-h-11 rounded-2xl bg-subsurface px-3"
                        value={predictorKey}
                        onChange={(event) => setPredictorKey(event.target.value as PredictorKey)}
                      >
                        {predictorOptions.map((option) => (
                          <option key={option.key} value={option.key}>{option.label}</option>
                        ))}
                      </select>
                    )}
                  </label>
                </div>
              </header>
              {isExploratoryFallback && (
                <p className="mb-3 rounded-2xl bg-[color-mix(in_srgb,var(--warning)_16%,white)] px-4 py-3 text-sm text-warning">
                  No meaningful correlations yet. Showing exploratory correlations from full history.
                </p>
              )}
              {!displayedCorrelationCards.length ? (
                <p className="rounded-2xl bg-subsurface px-4 py-3 text-sm text-muted">
                  Insufficient data for the selected target. Keep tracking to unlock meaningful and exploratory results.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:gap-3">
                  {displayedCorrelationCards.map((pair) => (
                    <button
                      key={pair.key}
                      type="button"
                      className={clsx(
                        "focusable rounded-[18px] bg-subsurface p-3 text-left transition sm:rounded-[22px] sm:p-4",
                        pair.predictor === predictorKey && pair.outcome === outcomeKey
                          ? "ring-2 ring-accent"
                          : "hover:bg-[color-mix(in_srgb,var(--surface)_72%,white)]",
                      )}
                      onClick={() => {
                        setPredictorKey(pair.predictor);
                        setOutcomeKey(pair.outcome);
                      }}
                    >
                      <div className="mb-1.5 flex flex-col items-start gap-1.5 sm:mb-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                        <h4 className="text-xs font-semibold tracking-tight sm:text-sm">{pair.predictorLabel} vs {pair.outcomeLabel}</h4>
                        <span
                          className={clsx(
                            "rounded-capsule px-2 py-1 text-[10px] font-semibold sm:px-3 sm:text-xs",
                            pair.classification === "meaningful"
                              ? "bg-[color-mix(in_srgb,var(--success)_14%,white)] text-success"
                              : "bg-[color-mix(in_srgb,var(--warning)_16%,white)] text-warning",
                          )}
                        >
                          {pair.classification === "meaningful" ? "Meaningful" : "Exploratory"}
                        </span>
                      </div>
                      <p className="line-clamp-3 text-xs text-muted sm:line-clamp-none sm:text-sm">
                        {describeCorrelationDirection(pair)}
                      </p>
                      <p className="metric-number mt-2 text-[10px] text-muted sm:hidden">
                        {pair.testType === "continuous"
                          ? `r=${(pair.correlation ?? 0).toFixed(2)} · N=${pair.sampleCount}`
                          : `eta²=${(pair.etaSquared ?? 0).toFixed(3)} · N=${pair.sampleCount}`}
                      </p>
                      <p className="metric-number mt-2 hidden text-xs text-muted sm:block">
                        {pair.testType === "continuous"
                          ? `r=${(pair.correlation ?? 0).toFixed(2)} · slope=${pair.regression?.slope.toFixed(3) ?? "--"} · p=${pair.pValue?.toExponential(2) ?? "--"} · q=${pair.qValue?.toExponential(2) ?? "--"} · N=${pair.sampleCount}`
                          : `eta²=${(pair.etaSquared ?? 0).toFixed(3)} · F=${pair.fStatistic?.toFixed(2) ?? "--"} · p=${pair.pValue?.toExponential(2) ?? "--"} · q=${pair.qValue?.toExponential(2) ?? "--"} · N=${pair.sampleCount}`}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </article>

            <article className="panel p-6 sm:p-8">
              <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">Explorer</h3>
                  <p className="text-sm text-muted">Inspect any predictor/outcome pair visually.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Predictor (X)</span>
                    <select
                      className="focusable min-h-11 rounded-2xl bg-subsurface px-3"
                      value={predictorKey}
                      onChange={(event) => setPredictorKey(event.target.value as PredictorKey)}
                    >
                      {predictorOptions.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Outcome (Y)</span>
                    <select
                      className="focusable min-h-11 rounded-2xl bg-subsurface px-3"
                      value={outcomeKey}
                      onChange={(event) => setOutcomeKey(event.target.value as OutcomeKey)}
                    >
                      {outcomeOptions.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </header>
              {selectedCorrelationPair ? (
                <>
                  <p className="metric-number mb-4 text-sm text-muted">
                    {selectedCorrelationPair.testType === "continuous"
                      ? `r=${(selectedCorrelationPair.correlation ?? 0).toFixed(3)} · slope=${selectedCorrelationPair.regression?.slope.toFixed(3) ?? "--"} · p=${selectedCorrelationPair.pValue?.toExponential(2) ?? "--"} · q=${selectedCorrelationPair.qValue?.toExponential(2) ?? "--"} · N=${selectedCorrelationPair.sampleCount}`
                      : `eta²=${(selectedCorrelationPair.etaSquared ?? 0).toFixed(3)} · F=${selectedCorrelationPair.fStatistic?.toFixed(2) ?? "--"} · p=${selectedCorrelationPair.pValue?.toExponential(2) ?? "--"} · q=${selectedCorrelationPair.qValue?.toExponential(2) ?? "--"} · N=${selectedCorrelationPair.sampleCount}`}
                  </p>
                  <div ref={correlationChartRef} className="relative h-[420px]">
                    <ResponsiveContainer>
                      <ScatterChart>
                        <CartesianGrid stroke="rgba(18,18,18,0.06)" strokeDasharray="3 6" />
                        <XAxis
                          axisLine={false}
                          dataKey={selectedCorrelationPair.testType === "categorical" ? "xJittered" : "x"}
                          domain={selectedCorrelationPair.testType === "categorical"
                            ? [-0.5, Math.max(0, (selectedCorrelationPair.categoryLabels?.length ?? 1) - 0.5)]
                            : continuousExplorerXDomain}
                          label={{
                            value: getOptionLabel(predictorOptions, predictorKey, predictorKey),
                            position: "insideBottom",
                            offset: -2,
                            style: { fill: "rgba(18,18,18,0.62)", fontSize: 12 },
                          }}
                          name={getOptionLabel(predictorOptions, predictorKey, predictorKey)}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(value: number) => {
                            if (selectedCorrelationPair.testType !== "categorical") {
                              return String(Math.round(value * 10) / 10);
                            }
                            const labels = selectedCorrelationPair.categoryLabels ?? [];
                            const index = Math.round(value);
                            return labels[index] ?? String(index);
                          }}
                          tickLine={false}
                          type="number"
                        />
                        <YAxis
                          axisLine={false}
                          dataKey="y"
                          domain={correlationExplorerYAxis?.domain}
                          label={{
                            value: getOptionLabel(outcomeOptions, outcomeKey, outcomeKey),
                            angle: -90,
                            position: "insideLeft",
                            style: { fill: "rgba(18,18,18,0.62)", fontSize: 12, textAnchor: "middle" },
                          }}
                          name={getOptionLabel(outcomeOptions, outcomeKey, outcomeKey)}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(value: number) => formatTooltipNumber(value)}
                          tickLine={false}
                          ticks={correlationExplorerYAxis?.ticks}
                          type="number"
                        />
                        <Scatter
                          data={selectedCorrelationPair.testType === "categorical"
                            ? categoricalScatterData
                            : selectedCorrelationPair.points}
                          fill={outcomeKey.startsWith("metric:")
                            ? getMetricColor(outcomeKey.slice("metric:".length) as MetricKey)
                            : "#3f6686"}
                          onMouseEnter={handleCorrelationPointEnter}
                          onMouseLeave={handleCorrelationPointLeave}
                        />
                        {selectedCorrelationPair.testType === "categorical" && (
                          <Scatter data={categoricalMeanData} fill="#CC5833" name="Group means" />
                        )}
                        {selectedCorrelationPair.testType === "continuous" && (
                          <Scatter
                            data={trendLineData}
                            fill="transparent"
                            legendType="none"
                            line={{ stroke: "#CC5833", strokeWidth: 2 }}
                            name="Trend"
                            shape={() => null}
                          />
                        )}
                      </ScatterChart>
                    </ResponsiveContainer>
                    {activeCorrelationTooltipContent && activeCorrelationTooltipStyle && (
                      <div
                        className="absolute z-20 max-h-[26rem] w-[24rem] overflow-y-scroll rounded-lg border border-black/10 bg-white/95 px-3 py-2 shadow-sm"
                        style={activeCorrelationTooltipStyle}
                        onMouseEnter={handleCorrelationTooltipEnter}
                        onMouseLeave={handleCorrelationTooltipLeave}
                      >
                        <p className="mb-1 text-xs text-muted">
                          Predictor: {formatReadableDate(activeCorrelationTooltipContent.predictorSourceDate)} | Outcome: {formatReadableDate(activeCorrelationTooltipContent.outcomeSourceDate)}
                        </p>
                        <div className="space-y-1">
                          <p className="text-sm text-ink">
                            {activeCorrelationTooltipContent.predictorLabel}: {activeCorrelationTooltipContent.predictorValue}
                          </p>
                          <p className="text-sm text-ink">
                            {activeCorrelationTooltipContent.outcomeLabel}: {activeCorrelationTooltipContent.outcomeValue}
                          </p>
                        </div>
                        {!!activeCorrelationTooltipContent.sections.length && (
                          <div className="mt-3 space-y-3 border-t border-black/10 pt-3">
                            {activeCorrelationTooltipContent.sections.map((section) => (
                              <div key={section.title}>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                                  {section.title}
                                  {section.sourceDateLabel ? ` · ${section.sourceDateLabel}` : ""}
                                </p>
                                <div className="mt-1 space-y-1">
                                  {section.items.map((item) => (
                                    <p key={`${section.title}:${item.label}`} className="text-xs text-ink">
                                      <span className="font-medium">{item.label}:</span> {item.value}
                                    </p>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <p className="rounded-2xl bg-subsurface px-4 py-3 text-sm text-muted">
                  Select a valid predictor/outcome pair to explore.
                </p>
              )}
            </article>
          </section>
  );

}
