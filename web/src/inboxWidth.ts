import { SIDEBAR_DEFAULT } from "./sidebarWidth";

export const INBOX_DEFAULT = 820;
export const INBOX_MIN = 480;
export const INBOX_MAX = 2400;
export const INBOX_WIDTH_KEY = "magictodo:inbox-width";
const INBOX_GUTTER = 16;

function sidebarPx(): number {
  if (typeof document === "undefined") return SIDEBAR_DEFAULT;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : SIDEBAR_DEFAULT;
}

function roomMax(): number {
  if (typeof window === "undefined") return INBOX_DEFAULT;
  return Math.max(INBOX_MIN, window.innerWidth - sidebarPx() - INBOX_GUTTER);
}

export function clampInboxWidth(px: number, persistable = false): number {
  const hardMax = persistable ? INBOX_MAX : Math.min(INBOX_MAX, roomMax());
  return Math.round(Math.min(hardMax, Math.max(INBOX_MIN, px)));
}

export function readInboxWidth(): number {
  try {
    const raw = localStorage.getItem(INBOX_WIDTH_KEY);
    if (!raw) return INBOX_DEFAULT;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampInboxWidth(parsed, true);
  } catch {
    /* ignore */
  }
  return INBOX_DEFAULT;
}

export function writeInboxWidth(px: number): void {
  try {
    localStorage.setItem(INBOX_WIDTH_KEY, String(clampInboxWidth(px, true)));
  } catch {
    /* ignore */
  }
}

export function displayedInboxWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--inbox-width");
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed)) return clampInboxWidth(parsed);
  return clampInboxWidth(readInboxWidth());
}

export function applyInboxWidth(px: number, persist = true): number {
  const preferred = clampInboxWidth(px, true);
  const next = clampInboxWidth(preferred);
  document.documentElement.style.setProperty("--inbox-width", `${next}px`);
  if (persist) writeInboxWidth(preferred);
  return next;
}

export function applyStoredInboxWidth(): number {
  return applyInboxWidth(readInboxWidth(), false);
}
