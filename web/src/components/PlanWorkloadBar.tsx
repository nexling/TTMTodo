import { workloadColor, workloadLabel, workloadWidth, type PlanViewMode } from "../planWorkload";

export function PlanWorkloadBar({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = workloadLabel(count);
  return (
    <div
      className="plan-load"
      style={{ width: `${workloadWidth(count) * 100}%`, background: workloadColor(count) }}
      title={count === 1 ? "1 task" : `${count} tasks`}
    >
      <span>{label}</span>
    </div>
  );
}

export function PlanViewSwitch({
  mode,
  onChange,
}: {
  mode: PlanViewMode;
  onChange: (mode: PlanViewMode) => void;
}) {
  return (
    <div className="plan-zoom" role="group" aria-label="Task display">
      <button
        className={`btn ghost small${mode === "cards" ? " on" : ""}`}
        type="button"
        onClick={() => onChange("cards")}
      >
        Cards
      </button>
      <button
        className={`btn ghost small${mode === "bars" ? " on" : ""}`}
        type="button"
        onClick={() => onChange("bars")}
      >
        Bars
      </button>
    </div>
  );
}
