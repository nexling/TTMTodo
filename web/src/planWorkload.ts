import { useState } from "react";

export type PlanViewMode = "cards" | "bars" | "projects";

const VIEW_KEY = "magictodo:plan-view";

export function readPlanView(): PlanViewMode {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    if (stored === "bars" || stored === "projects") return stored;
    return "cards";
  } catch {
    return "cards";
  }
}

export function writePlanView(mode: PlanViewMode): void {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function usePlanView(): [PlanViewMode, (mode: PlanViewMode) => void] {
  const [mode, setMode] = useState<PlanViewMode>(() => readPlanView());
  function change(next: PlanViewMode) {
    setMode(next);
    writePlanView(next);
  }
  return [mode, change];
}

export function workloadWidth(count: number): number {
  if (count <= 0) return 0;
  return Math.min(count, 10) / 10;
}

export function workloadLabel(count: number): string {
  return count >= 10 ? "10+" : String(count);
}

/** Green at 1 task, dark red at 10 or more, evenly spaced between. */
export function workloadColor(count: number): string {
  const step = Math.min(Math.max(count, 1), 10);
  const amount = (step - 1) / 9;
  const hue = Math.round(132 * (1 - amount));
  const sat = Math.round(52 + 16 * amount);
  const light = Math.round(36 - 8 * amount);
  return `hsl(${hue} ${sat}% ${light}%)`;
}
