import type { ProjectSpan } from "../planSpan";
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
      <button
        className={`btn ghost small${mode === "projects" ? " on" : ""}`}
        type="button"
        onClick={() => onChange("projects")}
      >
        Projects
      </button>
    </div>
  );
}

const SPAN_BAR = 22;
const SPAN_GAP = 4;

export function PlanProjectSpans({
  spans,
  columnCount,
  gridRow,
}: {
  spans: ProjectSpan[];
  columnCount: number;
  gridRow: number;
}) {
  if (spans.length === 0 || columnCount <= 0) return null;
  return (
    <div className="plan-span-layer" style={{ gridRow, gridColumn: "2 / -1" }}>
      <div
        className="plan-span-stack"
        style={{ height: spans.length * SPAN_BAR + (spans.length - 1) * SPAN_GAP }}
      >
        {spans.map((span, index) => (
          <div
            key={span.id}
            className="plan-span"
            title={span.name}
            style={{
              top: index * (SPAN_BAR + SPAN_GAP),
              left: `${(span.start / columnCount) * 100}%`,
              width: `${((span.end - span.start + 1) / columnCount) * 100}%`,
              background: span.gradient,
            }}
          >
            <span>{span.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
