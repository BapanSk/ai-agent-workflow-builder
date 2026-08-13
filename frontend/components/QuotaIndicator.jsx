export default function QuotaIndicator({ label, used, quota }) {
  const pct = quota > 0 ? Math.round((used / quota) * 100) : 0;
  const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  return (
    <div className="card">
      <div className="spread">
        <h2 style={{ margin: 0 }}>{label}</h2>
        <span className="muted">
          {used} / {quota}
        </span>
      </div>
      <div className={`meter ${cls}`}>
        <div style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <p className="muted">
        {pct >= 100
          ? 'Quota exhausted — further runs will be rejected.'
          : `${pct}% used this period.`}
      </p>
    </div>
  );
}
