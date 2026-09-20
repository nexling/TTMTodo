export const PLAN_EDITOR_DEFAULT = 320;
export const PLAN_EDITOR_MIN = 160;
export const PLAN_EDITOR_GRID_MIN = 160;
export const PLAN_EDITOR_PERSIST_MAX = 1600;
export const PLAN_EDITOR_HEIGHT_KEY = "magictodo:plan-editor-height";
export const PLAN_EDITOR_VAR = "--plan-editor-height";

function leftoverHeight(): number {
  if (typeof window === "undefined") return PLAN_EDITOR_DEFAULT + PLAN_EDITOR_GRID_MIN;
  const main = document.querySelector<HTMLElement>(".main.plan");
  if (!main) return PLAN_EDITOR_DEFAULT + PLAN_EDITOR_GRID_MIN;
  const style = getComputedStyle(main);
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  let chrome = Number.isFinite(padding) ? padding : 0;
  for (const child of Array.from(main.children)) {
    const el = child as HTMLElement;
    if (el.classList.contains("plan-grid-wrap") || el.classList.contains("plan-editor")) continue;
    const cs = getComputedStyle(el);
    chrome +=
      el.offsetHeight + Number.parseFloat(cs.marginTop) + Number.parseFloat(cs.marginBottom);
  }
  return Math.max(0, main.clientHeight - chrome);
}

function roomMax(): number {
  return Math.max(PLAN_EDITOR_MIN, leftoverHeight() - PLAN_EDITOR_GRID_MIN);
}

export function clampPlanEditorHeight(px: number, persistable = false): number {
  const hardMax = persistable ? PLAN_EDITOR_PERSIST_MAX : roomMax();
  const hardMin = persistable ? PLAN_EDITOR_MIN : Math.min(PLAN_EDITOR_MIN, hardMax);
  return Math.round(Math.min(hardMax, Math.max(hardMin, px)));
}

export function defaultPlanEditorHeight(): number {
  const forty = Math.round(leftoverHeight() * 0.4);
  const preferred = Math.min(PLAN_EDITOR_DEFAULT, forty || PLAN_EDITOR_DEFAULT);
  return clampPlanEditorHeight(preferred);
}

export function readPlanEditorHeight(): number {
  try {
    const raw = localStorage.getItem(PLAN_EDITOR_HEIGHT_KEY);
    if (!raw) return defaultPlanEditorHeight();
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampPlanEditorHeight(parsed, true);
  } catch {
    /* ignore */
  }
  return defaultPlanEditorHeight();
}

export function writePlanEditorHeight(px: number): void {
  try {
    localStorage.setItem(PLAN_EDITOR_HEIGHT_KEY, String(clampPlanEditorHeight(px, true)));
  } catch {
    /* ignore */
  }
}

export function displayedPlanEditorHeight(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(PLAN_EDITOR_VAR);
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed)) return clampPlanEditorHeight(parsed);
  return clampPlanEditorHeight(readPlanEditorHeight());
}

export function applyPlanEditorHeight(px: number, persist = true): number {
  const preferred = clampPlanEditorHeight(px, true);
  const next = clampPlanEditorHeight(preferred);
  document.documentElement.style.setProperty(PLAN_EDITOR_VAR, `${next}px`);
  if (persist) writePlanEditorHeight(preferred);
  return next;
}

export function applyStoredPlanEditorHeight(): number {
  return applyPlanEditorHeight(readPlanEditorHeight(), false);
}

export function applyDefaultPlanEditorHeight(): number {
  return applyPlanEditorHeight(defaultPlanEditorHeight());
}
