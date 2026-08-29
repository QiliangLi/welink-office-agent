export function ProgressBar({ value, label = "任务进度" }: { value: number; label?: string }) {
  const safeValue = Math.min(100, Math.max(0, value));
  return (
    <div className="progress-wrap">
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={safeValue}>
        <span className="progress-fill" style={{ width: `${safeValue}%` }} />
      </div>
      <span className="progress-number">{safeValue}%</span>
    </div>
  );
}
