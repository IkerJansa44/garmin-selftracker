import {
  Bar,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from "recharts";

import {
  formatOvernightClockLabel,
  type SleepWindowChartPoint,
} from "../lib/dashboardPlots";

interface SleepWindowChartProps {
  averageBedtime: number | null;
  averageWakeTime: number | null;
  axisOffsetMinutes: number;
  barColor: string;
  chartId: string;
  domain: [number, number];
  points: SleepWindowChartPoint[];
}

interface SleepAverageLabel {
  positionPx: number;
  value: number;
}

function formatSleepConsistencyMinutes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  })} min`;
}

function resolveSleepBarColor(baseColor: string): string {
  if (baseColor === "#4b7394") {
    return "#6f97b8";
  }
  return baseColor;
}

function buildAverageLabelPosition(
  value: number,
  domain: [number, number],
): SleepAverageLabel {
  const span = domain[1] - domain[0];
  const ratio = span <= 0 ? 0.5 : (value - domain[0]) / span;
  return {
    value,
    positionPx: Math.min(62, Math.max(2, 2 + ratio * 60)),
  };
}

function SleepWindowTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: SleepWindowChartPoint }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }
  const point = payload.find((entry) => entry.payload)?.payload;
  if (!point) {
    return null;
  }
  return (
    <div className="rounded-2xl bg-panel px-3 py-2 text-xs shadow-soft">
      <p className="metric-number font-mono">
        Bed {point.bedtimeValue === null ? "--" : formatOvernightClockLabel(point.bedtimeValue)}
      </p>
      <p className="metric-number mt-1 font-mono">
        Wake {point.wakeValue === null ? "--" : formatOvernightClockLabel(point.wakeValue)}
      </p>
      <p className="metric-number mt-1 font-mono">
        Sleep Consistency {formatSleepConsistencyMinutes(point.sleepConsistencyValue)}
      </p>
    </div>
  );
}

export function SleepWindowChart({
  averageBedtime,
  averageWakeTime,
  axisOffsetMinutes,
  barColor,
  chartId,
  domain,
  points,
}: SleepWindowChartProps) {
  const averageLabels = [
    averageBedtime === null ? null : buildAverageLabelPosition(averageBedtime, domain),
    averageWakeTime === null ? null : buildAverageLabelPosition(averageWakeTime, domain),
  ].filter((label): label is SleepAverageLabel => label !== null);
  const resolvedBarColor = resolveSleepBarColor(barColor);

  return (
    <div className="relative h-full pl-11">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-10">
        {averageLabels.map((label) => (
          <span
            key={label.value}
            className="absolute right-2 text-[10px] text-muted"
            style={{ top: `${label.positionPx}px`, transform: "translateY(-50%)" }}
          >
            {formatOvernightClockLabel(label.value + axisOffsetMinutes)}
          </span>
        ))}
      </div>
      <ResponsiveContainer>
        <ComposedChart
          barCategoryGap="25%"
          barGap={0}
          data={points}
          margin={{ top: 2, right: 4, bottom: 2, left: 6 }}
        >
          <YAxis
            hide
            yAxisId="sleep-window"
            allowDecimals={false}
            domain={domain}
            interval={0}
            reversed
          />
          {averageBedtime !== null && (
            <ReferenceLine
              className="sleep-avg-bedtime-line"
              data-testid="sleep-avg-bedtime-line"
              ifOverflow="extendDomain"
              stroke="rgba(18,18,18,0.45)"
              strokeDasharray="4 4"
              strokeWidth={1}
              y={averageBedtime}
              yAxisId="sleep-window"
            />
          )}
          {averageWakeTime !== null && (
            <ReferenceLine
              className="sleep-avg-waketime-line"
              data-testid="sleep-avg-waketime-line"
              ifOverflow="extendDomain"
              stroke="rgba(18,18,18,0.45)"
              strokeDasharray="4 4"
              strokeWidth={1}
              y={averageWakeTime}
              yAxisId="sleep-window"
            />
          )}
          <Line
            dataKey="sleepConsistencyPlotValue"
            dot={false}
            isAnimationActive={false}
            stroke="rgba(18,18,18,0.75)"
            strokeWidth={2}
            type="monotone"
            yAxisId="sleep-window"
          />
          <Bar
            dataKey="sleepWindowBase"
            fill="transparent"
            isAnimationActive={false}
            stackId={`sleep-window-${chartId}`}
            yAxisId="sleep-window"
          />
          <Bar
            className="sleep-night-window-bar"
            data-testid="sleep-night-window-bar"
            dataKey="sleepWindowDuration"
            fill={resolvedBarColor}
            isAnimationActive={false}
            maxBarSize={16}
            radius={[6, 6, 6, 6]}
            stackId={`sleep-window-${chartId}`}
            yAxisId="sleep-window"
          />
          <Tooltip content={<SleepWindowTooltip />} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
