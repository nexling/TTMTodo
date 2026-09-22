import { taskDueOn } from "./planZoom";

export type ProjectSpan = {
  id: string;
  name: string;
  start: number;
  end: number;
  gradient: string;
};

type SpanTask = {
  project_id: string;
  project_name?: string | null;
  due_on?: string | null;
  week_start: string;
};

/** Same muted green-to-dark-red ramp as the count bars. One project is the green, five or more is the dark red. */
export function overlapColor(count: number): string {
  const step = Math.min(Math.max(count, 1), 5);
  const amount = (step - 1) / 4;
  const hue = Math.round(132 * (1 - amount));
  const sat = Math.round(52 + 16 * amount);
  const light = Math.round(36 - 8 * amount);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function spanGradient(span: { start: number; end: number }, spans: { start: number; end: number }[]): string {
  const width = span.end - span.start + 1;
  const stops: string[] = [];
  for (let col = span.start; col <= span.end; col++) {
    let overlap = 0;
    for (const other of spans) {
      if (col >= other.start && col <= other.end) overlap += 1;
    }
    const color = overlapColor(overlap);
    const mid = ((col - span.start + 0.5) / width) * 100;
    if (col === span.start) stops.push(`${color} 0%`);
    stops.push(`${color} ${mid.toFixed(2)}%`);
    if (col === span.end) stops.push(`${color} 100%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

export function projectSpans(
  tasks: SpanTask[],
  columnKeys: string[],
  columnKeyOf: (dueOn: string) => string,
  fallbackName: string,
): ProjectSpan[] {
  if (columnKeys.length === 0) return [];
  const index = new Map(columnKeys.map((key, i) => [key, i]));
  const firstKey = columnKeys[0];
  const lastIndex = columnKeys.length - 1;
  const groups = new Map<string, { name: string; start: number; end: number; before: boolean; after: boolean }>();

  for (const task of tasks) {
    const dueOn = taskDueOn(task);
    const key = columnKeyOf(dueOn);
    let group = groups.get(task.project_id);
    if (!group) {
      group = {
        name: task.project_name || fallbackName,
        start: Number.POSITIVE_INFINITY,
        end: Number.NEGATIVE_INFINITY,
        before: false,
        after: false,
      };
      groups.set(task.project_id, group);
    } else if (task.project_name) {
      group.name = task.project_name;
    }
    const at = index.get(key);
    if (at == null) {
      if (key < firstKey) group.before = true;
      else group.after = true;
    } else {
      group.start = Math.min(group.start, at);
      group.end = Math.max(group.end, at);
    }
  }

  const placed: { id: string; name: string; start: number; end: number }[] = [];
  for (const [id, group] of groups) {
    let start = group.start;
    let end = group.end;
    if (group.before) start = 0;
    if (group.after) end = lastIndex;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) continue;
    placed.push({ id, name: group.name || fallbackName, start, end });
  }
  placed.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return placed.map((span) => ({ ...span, gradient: spanGradient(span, placed) }));
}
