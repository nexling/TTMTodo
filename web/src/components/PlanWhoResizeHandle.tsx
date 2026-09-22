import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef } from "react";
import { WHO_DEFAULT, WHO_MAX, WHO_MIN, displayedWhoWidth } from "../planWhoWidth";

export default function PlanWhoResizeHandle({
  width,
  onCommit,
  onReset,
}: {
  width: number | null;
  onCommit: (px: number) => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useLayoutEffect(() => {
    const buttonEl = ref.current;
    const wrapEl = buttonEl?.closest(".plan-grid-wrap");
    if (!buttonEl || !(wrapEl instanceof HTMLElement)) return;
    const button = buttonEl;
    const wrap = wrapEl;
    function sync() {
      button.style.height = `${wrap.clientHeight}px`;
    }
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  function columnWidth(target: HTMLElement): number {
    const wrap = target.closest(".plan-grid-wrap");
    if (wrap instanceof HTMLElement) return displayedWhoWidth(wrap);
    return width ?? WHO_DEFAULT;
  }

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { startX: e.clientX, startWidth: columnWidth(e.currentTarget) };
    document.body.classList.add("who-col-resizing");
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active) return;
    onCommit(active.startWidth + (e.clientX - active.startX));
  }

  function endDrag(target: HTMLButtonElement, pointerId: number) {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove("who-col-resizing");
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 32 : 16;
    const current = columnWidth(e.currentTarget);
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onCommit(current - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onCommit(current + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      onCommit(WHO_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      onCommit(WHO_MAX);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onReset();
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      className="plan-who-resize"
      aria-label="Resize who column"
      title="Drag to resize"
      aria-valuemin={WHO_MIN}
      aria-valuemax={WHO_MAX}
      aria-valuenow={width ?? WHO_DEFAULT}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => endDrag(e.currentTarget, e.pointerId)}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onReset();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    />
  );
}
