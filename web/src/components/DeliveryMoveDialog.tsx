import { offsetDaysLabel } from "./ShiftRelatedDialog";

export type DeliveryMovePrompt = {
  previous: string;
  next: string;
  offsetDays: number;
};

export function DeliveryMoveDialog(props: {
  prompt: DeliveryMovePrompt;
  busy: boolean;
  onMoveAll: () => void;
  onMarkOnly: () => void;
  onCancel: () => void;
}) {
  const { prompt, busy, onMoveAll, onMarkOnly, onCancel } = props;
  return (
    <div
      className="plan-shift-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plan-delivery-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="panel">
        <h2 id="plan-delivery-title">Move delivery?</h2>
        <p>
          Delivery is moving {offsetDaysLabel(prompt.offsetDays)}. Move every card in this project by the same amount,
          or only move the delivery mark?
        </p>
        <div className="composer-row plan-delivery-actions">
          <button className="btn ghost" type="button" disabled={busy} onClick={onMoveAll}>
            Move all cards in this project
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={onMarkOnly}>
            Only move the delivery mark
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
