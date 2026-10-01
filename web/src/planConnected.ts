import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { api, type PlanRelated, type PlanTask } from "./api";

export type ConnectedIds = {
  sourceId: string;
  upstream: Set<string>;
  following: Set<string>;
};

export type ConnectedChainState = ConnectedIds | "loading" | "error";

export type TemplateConnectedTask = {
  key: string;
  id?: string;
  predecessor_keys: string[];
};

export function relatedToConnected(taskId: string, related: PlanRelated): ConnectedIds {
  return {
    sourceId: taskId,
    upstream: new Set(related.upstream.map((row) => row.id)),
    following: new Set(related.following.map((row) => row.id)),
  };
}

export function chainSize(chain: ConnectedIds): number {
  return chain.upstream.size + chain.following.size;
}

export function connectedChipClass(id: string, connected: ConnectedIds | null): string {
  if (!connected) return "";
  if (id === connected.sourceId) return " conn-source";
  if (connected.upstream.has(id)) return " conn-upstream";
  if (connected.following.has(id)) return " conn-following";
  return " conn-dim";
}

export function paintedIdsFromCells(tasksByCell: Map<string, { id: string }[]>): Set<string> {
  const ids = new Set<string>();
  for (const list of tasksByCell.values()) {
    for (const task of list) ids.add(task.id);
  }
  return ids;
}

export function paintedKeysFromCells(tasksByCell: Map<string, { key: string }[]>): Set<string> {
  const keys = new Set<string>();
  for (const list of tasksByCell.values()) {
    for (const task of list) keys.add(task.key);
  }
  return keys;
}

export function hiddenConnectedCount(connected: ConnectedIds, painted: Set<string>): number {
  let n = 0;
  for (const id of connected.upstream) {
    if (!painted.has(id)) n += 1;
  }
  for (const id of connected.following) {
    if (!painted.has(id)) n += 1;
  }
  return n;
}

export function walkTemplateConnected(source: TemplateConnectedTask, all: TemplateConnectedTask[]): ConnectedIds {
  const byAny = new Map<string, TemplateConnectedTask>();
  for (const task of all) {
    byAny.set(task.key, task);
    if (task.id) byAny.set(task.id, task);
  }
  const succs = new Map<string, string[]>();
  for (const task of all) {
    for (const pred of task.predecessor_keys) {
      const predTask = byAny.get(pred);
      const predKey = predTask?.key ?? pred;
      const list = succs.get(predKey) || [];
      list.push(task.key);
      succs.set(predKey, list);
    }
  }

  function neighborsOf(key: string, outgoing: boolean): string[] {
    if (outgoing) return succs.get(key) || [];
    const row = byAny.get(key);
    if (!row) return [];
    return row.predecessor_keys.map((pred) => byAny.get(pred)?.key ?? pred);
  }

  function walk(start: string[], outgoing: boolean): Set<string> {
    const found = new Set<string>();
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length) {
      const key = queue.shift();
      if (!key || seen.has(key) || key === source.key) continue;
      seen.add(key);
      const row = byAny.get(key);
      if (!row) continue;
      found.add(row.key);
      queue.push(...neighborsOf(row.key, outgoing));
    }
    return found;
  }

  const predKeys = source.predecessor_keys.map((pred) => byAny.get(pred)?.key ?? pred);
  return {
    sourceId: source.key,
    upstream: walk(predKeys, false),
    following: walk(succs.get(source.key) || [], true),
  };
}

export function scrollConnectedIntoView(wrap: HTMLElement | null) {
  if (!wrap) return;
  const chips = [...wrap.querySelectorAll<HTMLElement>(".plan-chip.conn-upstream, .plan-chip.conn-following")];
  if (!chips.length) return;
  const wrapRect = wrap.getBoundingClientRect();
  const visible = chips.some((chip) => rectsOverlap(chip.getBoundingClientRect(), wrapRect));
  if (visible) return;
  const cx = wrapRect.left + wrapRect.width / 2;
  const cy = wrapRect.top + wrapRect.height / 2;
  let best = chips[0];
  let bestDist = Infinity;
  for (const chip of chips) {
    const rect = chip.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - cx;
    const dy = rect.top + rect.height / 2 - cy;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = chip;
    }
  }
  best.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function connectedGridClick(event: ReactMouseEvent<HTMLElement>, hide: () => void) {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.closest(".plan-chip")) return;
  hide();
}

export function useConnectedOverlay(
  gridWrapRef: RefObject<HTMLElement | null>,
  extraDeps: unknown[] = [],
) {
  const [connected, setConnected] = useState<ConnectedIds | null>(null);

  const hideConnected = useCallback(() => {
    setConnected(null);
  }, []);

  const showConnected = useCallback((next: ConnectedIds) => {
    setConnected(next);
  }, []);

  useEffect(() => {
    if (!connected) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") hideConnected();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connected, hideConnected]);

  useLayoutEffect(() => {
    if (!connected) return;
    const wrap = gridWrapRef.current;
    if (!wrap) return;
    const run = () => scrollConnectedIntoView(wrap);
    run();
    const frame = window.requestAnimationFrame(run);
    return () => window.cancelAnimationFrame(frame);
    // extraDeps lets callers wait until cards are painted (view mode, cell map).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, gridWrapRef, ...extraDeps]);

  return { connected, showConnected, hideConnected };
}

export function loadConnectedChain(taskId: string): Promise<ConnectedIds> {
  return api.planTaskConnected(taskId).then((related) => relatedToConnected(taskId, related));
}

export type ConnectedTaskMenu = {
  task: PlanTask;
  x: number;
  y: number;
  chain: ConnectedChainState;
};

export function useLiveConnectedMenu() {
  const [taskMenu, setTaskMenu] = useState<ConnectedTaskMenu | null>(null);

  function closeTaskMenu() {
    setTaskMenu(null);
  }

  function onTaskContextMenu(event: ReactMouseEvent<HTMLElement>, task: PlanTask) {
    event.preventDefault();
    event.stopPropagation();
    setTaskMenu({ task, x: event.clientX, y: event.clientY, chain: "loading" });
    void loadConnectedChain(task.id)
      .then((chain) => {
        setTaskMenu((prev) => (prev?.task.id === task.id ? { ...prev, chain } : prev));
      })
      .catch(() => {
        setTaskMenu((prev) => (prev?.task.id === task.id ? { ...prev, chain: "error" } : prev));
      });
  }

  useEffect(() => {
    if (!taskMenu) return;
    function close() {
      setTaskMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    function onContext(event: Event) {
      event.preventDefault();
      close();
    }
    const timer = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", onContext);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKey);
    };
  }, [taskMenu]);

  return { taskMenu, setTaskMenu, closeTaskMenu, onTaskContextMenu };
}
