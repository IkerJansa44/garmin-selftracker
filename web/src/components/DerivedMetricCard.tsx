interface DerivedMetricCardProps {
  label: string;
  value: string;
  helperText: string;
}

export function DerivedMetricCard({
  label,
  value,
  helperText,
}: DerivedMetricCardProps) {
  return (
    <div className="mt-5 rounded-[22px] bg-subsurface p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-muted">Derived Metric</p>
      <p className="mt-2 text-sm text-muted">{label}</p>
      <p className="metric-number mt-1 text-2xl font-semibold text-ink">{value}</p>
      <p className="mt-1 text-xs text-muted">{helperText}</p>
    </div>
  );
}
