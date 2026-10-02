import {
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type MarqueeRect = { left: number; top: number; right: number; bottom: number };

const MARQUEE_THRESHOLD = 4;
const SCROLL_EDGE = 36;
const SCROLL_STEP = 22;

function rect(a: { x: number; y: number }, b: { x: number; y: number }): MarqueeRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

function intersects(a: MarqueeRect, b: MarqueeRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function elementRect(el: Element): MarqueeRect {
  const box = el.getBoundingClientRect();
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function idsInRect(wrap: HTMLElement, area: MarqueeRect, canSelectId: (id: string) => boolean): string[] {
  const ids: string[] = [];
  for (const node of wrap.querySelectorAll("[data-plan-chip-id]")) {
    if (!(node instanceof HTMLElement)) continue;
    const id = node.dataset.planChipId;
    if (!id || !canSelectId(id)) continue;
    if (intersects(area, elementRect(node))) ids.push(id);
  }
  return ids;
}

function chipRect(wrap: HTMLElement, id: string): MarqueeRect | null {
  const node = wrap.querySelector(`[data-plan-chip-id="${CSS.escape(id)}"]`);
  return node instanceof HTMLElement ? elementRect(node) : null;
}

function mergeIds(base: Set<string>, ids: string[], additive: boolean): Set<string> {
  if (!additive) return new Set(ids);
  const next = new Set(base);
  for (const id of ids) next.add(id);
  return next;
}

function pruneIds(prev: Set<string>, painted: Set<string>): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const id of prev) {
    if (painted.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : prev;
}

function autoscroll(wrap: HTMLElement, x: number, y: number): void {
  const box = wrap.getBoundingClientRect();
  if (x > box.right - SCROLL_EDGE) wrap.scrollLeft += SCROLL_STEP;
  else if (x < box.left + SCROLL_EDGE) wrap.scrollLeft -= SCROLL_STEP;
  if (y > box.bottom - SCROLL_EDGE) wrap.scrollTop += SCROLL_STEP;
  else if (y < box.top + SCROLL_EDGE) wrap.scrollTop -= SCROLL_STEP;
}

export function setCountDragImage(dt: DataTransfer, source: HTMLElement, extraCount: number): void {
  if (extraCount <= 0) return;
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.classList.add("plan-chip-drag-ghost");
  ghost.style.width = `${source.offsetWidth}px`;
  const badge = document.createElement("span");
  badge.className = "plan-chip-drag-count";
  badge.textContent = `+${extraCount}`;
  ghost.appendChild(badge);
  document.body.appendChild(ghost);
  dt.setDragImage(ghost, Math.min(48, source.offsetWidth / 2), 18);
  window.requestAnimationFrame(() => ghost.remove());
}

export function usePlanSelection(opts: {
  enabled: boolean;
  wrapRef: { readonly current: HTMLElement | null };
  paintedIds: Set<string>;
  canSelectId: (id: string) => boolean;
  resetKey?: string;
}) {
  const { enabled, wrapRef, paintedIds, canSelectId, resetKey } = opts;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const selectedRef = useRef(selectedIds);
  const canSelectRef = useRef(canSelectId);
  const skipDragRef = useRef(false);
  const suppressClickRef = useRef(false);
  const snapshotRef = useRef<Set<string>>(new Set());
  const startRef = useRef<{ x: number; y: number; additive: boolean; active: boolean } | null>(null);
  selectedRef.current = selectedIds;
  canSelectRef.current = canSelectId;

  const clear = useCallback(() => {
    setSelectedIds((prev) => (prev.size ? new Set() : prev));
    setAnchorId(null);
  }, []);

  useEffect(() => {
    if (!enabled) clear();
  }, [enabled, clear]);

  useEffect(() => {
    clear();
  }, [resetKey, clear]);

  useEffect(() => {
    setSelectedIds((prev) => pruneIds(prev, paintedIds));
    setAnchorId((cur) => (cur && !paintedIds.has(cur) ? null : cur));
  }, [paintedIds]);

  useEffect(() => {
    if (!enabled) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (selectedRef.current.size) clear();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      const next = new Set<string>();
      for (const id of paintedIds) {
        if (canSelectRef.current(id)) next.add(id);
      }
      setSelectedIds(next);
      setAnchorId(next.size ? [...next][0] : null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clear, enabled, paintedIds]);

  function replaceWith(id: string) {
    if (!canSelectRef.current(id)) {
      clear();
      return;
    }
    setSelectedIds(new Set([id]));
    setAnchorId(id);
  }

  function onChipClick(event: ReactMouseEvent, id: string): { open: boolean } {
    if (!enabled) return { open: true };
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      if (!canSelectRef.current(id)) return { open: false };
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchorId(id);
      return { open: false };
    }
    if (event.shiftKey) {
      event.preventDefault();
      if (!canSelectRef.current(id)) return { open: false };
      const wrap = wrapRef.current;
      const fromId = anchorId && selectedRef.current.has(anchorId) ? anchorId : id;
      const a = wrap ? chipRect(wrap, fromId) : null;
      const b = wrap ? chipRect(wrap, id) : null;
      if (!wrap || !a || !b) {
        replaceWith(id);
        return { open: false };
      }
      const ids = idsInRect(
        wrap,
        {
          left: Math.min(a.left, b.left),
          top: Math.min(a.top, b.top),
          right: Math.max(a.right, b.right),
          bottom: Math.max(a.bottom, b.bottom),
        },
        canSelectRef.current,
      );
      setSelectedIds(new Set(ids.length ? ids : [id]));
      return { open: false };
    }
    replaceWith(id);
    return { open: true };
  }

  function onChipContextMenu(id: string) {
    if (!enabled) return;
    if (selectedRef.current.has(id)) return;
    replaceWith(id);
  }

  function onChipPointerDown(event: ReactPointerEvent) {
    skipDragRef.current = event.ctrlKey || event.metaKey || event.shiftKey;
  }

  function consumeDragStart(): boolean {
    if (!skipDragRef.current) return false;
    skipDragRef.current = false;
    return true;
  }

  function onCellPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!enabled) return;
    if (event.button !== 0) return;
    if (event.target !== event.currentTarget) return;
    const additive = event.ctrlKey || event.metaKey;
    startRef.current = { x: event.clientX, y: event.clientY, additive, active: false };
    snapshotRef.current = additive ? new Set(selectedRef.current) : new Set();

    const onMove = (ev: PointerEvent) => {
      const start = startRef.current;
      const wrap = wrapRef.current;
      if (!start || !wrap) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!start.active && dx * dx + dy * dy < MARQUEE_THRESHOLD * MARQUEE_THRESHOLD) return;
      if (!start.active) {
        start.active = true;
        suppressClickRef.current = true;
      }
      ev.preventDefault();
      autoscroll(wrap, ev.clientX, ev.clientY);
      const area = rect(start, { x: ev.clientX, y: ev.clientY });
      setMarquee(area);
      const ids = idsInRect(wrap, area, canSelectRef.current);
      setSelectedIds(mergeIds(snapshotRef.current, ids, start.additive));
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const start = startRef.current;
      startRef.current = null;
      setMarquee(null);
      if (!start?.active) return;
      const wrap = wrapRef.current;
      if (!wrap) return;
      const area = rect(start, { x: ev.clientX, y: ev.clientY });
      const ids = idsInRect(wrap, area, canSelectRef.current);
      const next = mergeIds(snapshotRef.current, ids, start.additive);
      setSelectedIds(next);
      setAnchorId(ids[ids.length - 1] || [...next][next.size - 1] || null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onWrapClick(event: ReactMouseEvent<HTMLElement>) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (!enabled) return false;
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    if (target.closest(".plan-chip, .plan-add, .plan-who-resize, .color-menu, .plan-editor")) return false;
    if (selectedRef.current.size) clear();
    return false;
  }

  return {
    selectedIds,
    marquee,
    selecting: Boolean(marquee),
    isSelected: (id: string) => selectedIds.has(id),
    onChipClick,
    onChipContextMenu,
    onChipPointerDown,
    consumeDragStart,
    onCellPointerDown,
    onWrapClick,
    clear,
  };
}
