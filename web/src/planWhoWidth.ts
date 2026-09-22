import { useEffect, useState } from "react";

export const WHO_DEFAULT = 168;
export const WHO_MIN = 140;
export const WHO_MAX = 560;
export const WHO_WIDTH_KEY = "magictodo:plan-who-width";

function roomMax(): number {
  if (typeof window === "undefined") return WHO_MAX;
  return Math.max(WHO_MIN, window.innerWidth - 220);
}

export function clampWhoWidth(px: number, persistable = false): number {
  const hardMax = persistable ? WHO_MAX : Math.min(WHO_MAX, roomMax());
  return Math.round(Math.min(hardMax, Math.max(WHO_MIN, px)));
}

export function readWhoWidth(): number | null {
  try {
    const raw = localStorage.getItem(WHO_WIDTH_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampWhoWidth(parsed, true);
  } catch {
    /* ignore */
  }
  return null;
}

export function writeWhoWidth(px: number): void {
  try {
    localStorage.setItem(WHO_WIDTH_KEY, String(clampWhoWidth(px, true)));
  } catch {
    /* ignore */
  }
}

export function clearWhoWidth(): void {
  try {
    localStorage.removeItem(WHO_WIDTH_KEY);
  } catch {
    /* ignore */
  }
}

export function displayedWhoWidth(wrap: HTMLElement): number {
  const raw = getComputedStyle(wrap).getPropertyValue("--plan-dept-col");
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed)) return clampWhoWidth(parsed);
  return WHO_DEFAULT;
}

export function useWhoColumnWidth(): {
  width: number | null;
  commit: (px: number) => void;
  reset: () => void;
} {
  const [width, setWidth] = useState<number | null>(() => {
    const stored = readWhoWidth();
    return stored == null ? null : clampWhoWidth(stored);
  });

  useEffect(() => {
    function applyStored() {
      const stored = readWhoWidth();
      setWidth(stored == null ? null : clampWhoWidth(stored));
    }
    function onStorage(e: StorageEvent) {
      if (e.key === WHO_WIDTH_KEY) applyStored();
    }
    window.addEventListener("resize", applyStored);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("resize", applyStored);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  function commit(px: number) {
    const preferred = clampWhoWidth(px, true);
    writeWhoWidth(preferred);
    setWidth(clampWhoWidth(preferred));
  }

  function reset() {
    clearWhoWidth();
    setWidth(null);
  }

  return { width, commit, reset };
}
