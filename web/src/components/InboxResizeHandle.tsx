import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from "react";
import {
  INBOX_DEFAULT,
  INBOX_MAX,
  INBOX_MIN,
  INBOX_WIDTH_KEY,
  applyInboxWidth,
  applyStoredInboxWidth,
  displayedInboxWidth,
} from "../inboxWidth";

export default function InboxResizeHandle() {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    applyStoredInboxWidth();

    function onResize() {
      applyStoredInboxWidth();
    }

    function onStorage(e: StorageEvent) {
      if (e.key === INBOX_WIDTH_KEY) applyStoredInboxWidth();
    }

    window.addEventListener("resize", onResize);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("storage", onStorage);
      document.body.classList.remove("inbox-resizing");
    };
  }, []);

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { startX: e.clientX, startWidth: displayedInboxWidth() };
    document.body.classList.add("inbox-resizing");
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active) return;
    applyInboxWidth(active.startWidth + (e.clientX - active.startX));
  }

  function endDrag(target: HTMLButtonElement, pointerId: number) {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove("inbox-resizing");
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 32 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applyInboxWidth(displayedInboxWidth() - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      applyInboxWidth(displayedInboxWidth() + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      applyInboxWidth(INBOX_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      applyInboxWidth(INBOX_MAX);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      applyInboxWidth(INBOX_DEFAULT);
    }
  }

  return (
    <button
      type="button"
      className="inbox-resize"
      aria-label="Resize inbox"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => endDrag(e.currentTarget, e.pointerId)}
      onDoubleClick={() => applyInboxWidth(INBOX_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  );
}
