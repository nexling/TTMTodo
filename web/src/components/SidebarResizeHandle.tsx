import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from "react";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_WIDTH_KEY,
  applySidebarWidth,
  applyStoredSidebarWidth,
  displayedSidebarWidth,
} from "../sidebarWidth";
import { applyStoredInboxWidth } from "../inboxWidth";

export default function SidebarResizeHandle() {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    applyStoredSidebarWidth();
    applyStoredInboxWidth();

    function onResize() {
      applyStoredSidebarWidth();
      applyStoredInboxWidth();
    }

    function onStorage(e: StorageEvent) {
      if (e.key === SIDEBAR_WIDTH_KEY) {
        applyStoredSidebarWidth();
        applyStoredInboxWidth();
      }
    }

    window.addEventListener("resize", onResize);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("storage", onStorage);
      document.body.classList.remove("sidebar-resizing");
    };
  }, []);

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { startX: e.clientX, startWidth: displayedSidebarWidth() };
    document.body.classList.add("sidebar-resizing");
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active) return;
    applySidebarWidth(active.startWidth + (e.clientX - active.startX));
    applyStoredInboxWidth();
  }

  function endDrag(target: HTMLButtonElement, pointerId: number) {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove("sidebar-resizing");
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 32 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applySidebarWidth(displayedSidebarWidth() - step);
      applyStoredInboxWidth();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      applySidebarWidth(displayedSidebarWidth() + step);
      applyStoredInboxWidth();
    } else if (e.key === "Home") {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_MIN);
      applyStoredInboxWidth();
    } else if (e.key === "End") {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_MAX);
      applyStoredInboxWidth();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_DEFAULT);
      applyStoredInboxWidth();
    }
  }

  return (
    <button
      type="button"
      className="sidebar-resize"
      aria-label="Resize sidebar"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => endDrag(e.currentTarget, e.pointerId)}
      onDoubleClick={() => {
        applySidebarWidth(SIDEBAR_DEFAULT);
        applyStoredInboxWidth();
      }}
      onKeyDown={onKeyDown}
    />
  );
}
