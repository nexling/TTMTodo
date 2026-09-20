export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 560;
export const SIDEBAR_WIDTH_KEY = "magictodo:sidebar-width";

function roomMax(): number {
  if (typeof window === "undefined") return SIDEBAR_MAX;
  return Math.max(SIDEBAR_MIN, window.innerWidth - 320);
}

export function clampSidebarWidth(px: number, persistable = false): number {
  const hardMax = persistable ? SIDEBAR_MAX : Math.min(SIDEBAR_MAX, roomMax());
  return Math.round(Math.min(hardMax, Math.max(SIDEBAR_MIN, px)));
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return SIDEBAR_DEFAULT;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampSidebarWidth(parsed, true);
  } catch {
    /* ignore */
  }
  return SIDEBAR_DEFAULT;
}

export function writeSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(px, true)));
  } catch {
    /* ignore */
  }
}

export function displayedSidebarWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar");
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed)) return clampSidebarWidth(parsed);
  return clampSidebarWidth(readSidebarWidth());
}

export function applySidebarWidth(px: number, persist = true): number {
  const preferred = clampSidebarWidth(px, true);
  const next = clampSidebarWidth(preferred);
  document.documentElement.style.setProperty("--sidebar", `${next}px`);
  if (persist) writeSidebarWidth(preferred);
  return next;
}

export function applyStoredSidebarWidth(): number {
  return applySidebarWidth(readSidebarWidth(), false);
}
