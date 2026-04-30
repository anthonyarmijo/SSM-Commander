interface StatusPillProps {
  label: string;
  tone?: "neutral" | "info" | "good" | "warn" | "bad";
}

export function StatusPill({ label, tone = "neutral" }: StatusPillProps) {
  return <span className={`status-pill status-pill--${tone}`}>{label}</span>;
}
