import { useEffect, useRef } from "react";

export type LiveEvent = {
  channel: "inbox" | "plan";
  project_id?: string | null;
};

type LiveHandler = (event: LiveEvent) => void;

const handlers = new Set<LiveHandler>();
let source: EventSource | null = null;

export function startLive(): void {
  if (source) return;
  source = new EventSource("/api/live");
  source.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data) as LiveEvent;
      if (data.channel !== "inbox" && data.channel !== "plan") return;
      for (const handler of handlers) handler(data);
    } catch {
      /* ignore malformed events */
    }
  };
}

export function stopLive(): void {
  source?.close();
  source = null;
}

export function onLiveEvent(handler: LiveHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function useLiveReload(shouldHandle: (event: LiveEvent) => boolean, reload: () => void | Promise<void>): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const predRef = useRef(shouldHandle);
  predRef.current = shouldHandle;

  useEffect(() => {
    let timer: number | undefined;
    const fire = () => {
      timer = undefined;
      void reloadRef.current();
    };
    const schedule = (delay: number) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(fire, delay);
    };
    const unsub = onLiveEvent((event) => {
      if (!predRef.current(event)) return;
      schedule(300);
    });
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      schedule(50);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) window.clearTimeout(timer);
    };
  }, []);
}
