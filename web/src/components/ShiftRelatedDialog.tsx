import { useState } from "react";

export type ShiftKind = "upstream" | "following";

export type ShiftRelated = { id: string; title: string };

export type ShiftAnswers = {
  upstream: boolean;
  following: boolean;
};

type ShiftQuestion = {
  kind: ShiftKind;
  related: ShiftRelated[];
};

export type ShiftPrompt = {
  title: string;
  offsetDays: number;
  kind: ShiftKind;
  related: ShiftRelated[];
  remaining: ShiftQuestion[];
  answers: ShiftAnswers;
  apply: (answers: ShiftAnswers) => Promise<void>;
};

export function offsetDaysLabel(offsetDays: number): string {
  const abs = Math.abs(offsetDays);
  const unit = abs === 1 ? "day" : "days";
  return offsetDays > 0 ? `${abs} ${unit} later` : `${abs} ${unit} earlier`;
}

export function ShiftRelatedDialog(props: {
  prompt: ShiftPrompt;
  busy: boolean;
  onResolve: (moveRelated: boolean) => void;
}) {
  const { prompt, busy, onResolve } = props;
  return (
    <div className="plan-shift-overlay" role="dialog" aria-modal="true" aria-labelledby="plan-shift-title">
      <div className="panel">
        <h2 id="plan-shift-title">Move related tasks?</h2>
        <p>
          “{prompt.title}” is moving {offsetDaysLabel(prompt.offsetDays)}.{" "}
          {prompt.kind === "upstream"
            ? `It depends on unfinished ${prompt.related.length === 1 ? "task" : "tasks"}:`
            : `Unfinished ${prompt.related.length === 1 ? "task depends" : "tasks depend"} on it:`}
        </p>
        <ul className="plan-dep-list">
          {prompt.related.map((task) => (
            <li key={task.id}>{task.title}</li>
          ))}
        </ul>
        <p>
          {prompt.kind === "upstream"
            ? "Move those by the same amount, or leave them where they are?"
            : "Move the following tasks by the same amount, or leave them where they are?"}
        </p>
        <div className="composer-row">
          <button className="btn" type="button" disabled={busy} onClick={() => onResolve(true)}>
            Move them too
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => onResolve(false)}>
            Leave them
          </button>
        </div>
      </div>
    </div>
  );
}

export function useShiftFlow() {
  const [shiftPrompt, setShiftPrompt] = useState<ShiftPrompt | null>(null);
  const [shiftBusy, setShiftBusy] = useState(false);

  function beginShiftFlow(opts: {
    title: string;
    offsetDays: number;
    upstream: ShiftRelated[];
    following: ShiftRelated[];
    apply: (answers: ShiftAnswers) => Promise<void>;
  }): boolean {
    const questions: ShiftQuestion[] = [];
    if (opts.upstream.length) questions.push({ kind: "upstream", related: opts.upstream });
    if (opts.following.length) questions.push({ kind: "following", related: opts.following });
    if (!opts.offsetDays || !questions.length) return false;
    const [first, ...remaining] = questions;
    setShiftPrompt({
      title: opts.title,
      offsetDays: opts.offsetDays,
      kind: first.kind,
      related: first.related,
      remaining,
      answers: { upstream: false, following: false },
      apply: opts.apply,
    });
    return true;
  }

  async function resolveShiftPrompt(moveRelated: boolean, onError: (message: string) => void): Promise<void> {
    if (!shiftPrompt || shiftBusy) return;
    const prompt = shiftPrompt;
    const answers = { ...prompt.answers, [prompt.kind]: moveRelated };
    if (prompt.remaining.length) {
      const [next, ...remaining] = prompt.remaining;
      setShiftPrompt({
        ...prompt,
        kind: next.kind,
        related: next.related,
        remaining,
        answers,
      });
      return;
    }
    setShiftBusy(true);
    try {
      await prompt.apply(answers);
      setShiftPrompt(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not move tasks");
      setShiftPrompt(null);
    } finally {
      setShiftBusy(false);
    }
  }

  return { shiftPrompt, shiftBusy, beginShiftFlow, resolveShiftPrompt, setShiftPrompt };
}
