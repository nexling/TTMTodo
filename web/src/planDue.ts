import { api, type Item } from "./api";
import type { ShiftAnswers, ShiftRelated } from "./components/ShiftRelatedDialog";
import { dayDelta, localYmdFromIso, ymdFromLocalInput } from "./planZoom";

export async function saveItemWithPlanDue(opts: {
  item: Item;
  dueAt: string | null;
  localDueInput: string;
  patch: (skipDueAt: boolean) => Promise<void>;
  beginShiftFlow: (opts: {
    title: string;
    offsetDays: number;
    upstream: ShiftRelated[];
    following: ShiftRelated[];
    apply: (answers: ShiftAnswers) => Promise<void>;
  }) => boolean;
}): Promise<"prompted" | "done"> {
  const { item, dueAt, localDueInput, patch, beginShiftFlow } = opts;
  const planTaskId = item.plan_task_id;
  const newDay = ymdFromLocalInput(localDueInput);
  const oldDay = localYmdFromIso(item.due_at);
  if (!planTaskId || !dueAt || !newDay || oldDay === newDay) {
    await patch(false);
    return "done";
  }
  const related = await api.planTaskRelated(planTaskId);
  const apply = async (answers: ShiftAnswers) => {
    await api.reschedulePlanTask(planTaskId, {
      due_on: newDay,
      shift_upstream: answers.upstream,
      shift_following: answers.following,
      due_at: dueAt,
    });
    await patch(true);
  };
  if (
    beginShiftFlow({
      title: item.title || "Task",
      offsetDays: dayDelta(oldDay || newDay, newDay),
      upstream: related.upstream,
      following: related.following,
      apply,
    })
  ) {
    return "prompted";
  }
  await apply({ upstream: false, following: false });
  return "done";
}
