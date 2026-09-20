import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from "react";
import {
  PLAN_EDITOR_HEIGHT_KEY,
  PLAN_EDITOR_MIN,
  PLAN_EDITOR_PERSIST_MAX,
  applyDefaultPlanEditorHeight,
  applyPlanEditorHeight,
  applyStoredPlanEditorHeight,
  displayedPlanEditorHeight,
} from "../planEditorHeight";

export default function PlanEditorResizeHandle() {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    applyStoredPlanEditorHeight();

    function onResize() {
      applyStoredPlanEditorHeight();
    }

    function onStorage(e: StorageEvent) {
      if (e.key === PLAN_EDITOR_HEIGHT_KEY) applyStoredPlanEditorHeight();
    }

    window.addEventListener("resize", onResize);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("storage", onStorage);
      document.body.classList.remove("plan-editor-resizing");
    };
  }, []);

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { startY: e.clientY, startHeight: displayedPlanEditorHeight() };
    document.body.classList.add("plan-editor-resizing");
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active) return;
    applyPlanEditorHeight(active.startHeight - (e.clientY - active.startY));
  }

  function endDrag(target: HTMLButtonElement, pointerId: number) {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove("plan-editor-resizing");
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 32 : 16;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      applyPlanEditorHeight(displayedPlanEditorHeight() + step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      applyPlanEditorHeight(displayedPlanEditorHeight() - step);
    } else if (e.key === "Home") {
      e.preventDefault();
      applyPlanEditorHeight(PLAN_EDITOR_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      applyPlanEditorHeight(PLAN_EDITOR_PERSIST_MAX);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      applyDefaultPlanEditorHeight();
    }
  }

  return (
    <button
      type="button"
      className="plan-editor-resize"
      aria-label="Resize task editor"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => endDrag(e.currentTarget, e.pointerId)}
      onDoubleClick={() => applyDefaultPlanEditorHeight()}
      onKeyDown={onKeyDown}
    />
  );
}
