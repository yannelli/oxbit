import { translate as tr } from "@oxbit/ui";

export type ContextUsage = { used: number; size: number; cost?: { amount: number; currency: string } };
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
export const HIGH_USAGE = 0.85;

/** The agent's context window fill as a ring, in the warning color from 85%. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const ratio = Math.min(1, usage.used / usage.size);
  const percent = Math.round(ratio * 100);
  const counts = `${usage.used.toLocaleString()}/${usage.size.toLocaleString()}`;
  const cost = usage.cost ? `${usage.cost.amount.toLocaleString()} ${usage.cost.currency}` : "";
  return (
    <div
      className="acp-usage"
      role="meter"
      aria-label={tr("Context usage")}
      aria-valuemin={0}
      aria-valuemax={usage.size}
      aria-valuenow={Math.min(usage.used, usage.size)}
      aria-valuetext={tr("{0}% of context used", { 0: percent })}
      data-level={ratio >= HIGH_USAGE ? "high" : undefined}
      data-tooltip={tr("{0} tokens", { 0: counts })}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="acp-usage-track" cx="8" cy="8" r={RADIUS} />
        <circle
          className="acp-usage-fill"
          cx="8" cy="8" r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span>{tr("{0}% context", { 0: percent })}</span>
      <span className="acp-usage-detail">{counts}{cost && ` · ${cost}`}</span>
    </div>
  );
}
