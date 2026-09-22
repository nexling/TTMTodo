export type PlanZoom = "day" | "week" | "month";
export type ScheduleDirection = "forward" | "backward";

export const ZOOM_COUNTS: Record<PlanZoom, number> = { day: 14, week: 12, month: 12 };

export const ZOOM_OPTIONS: { id: PlanZoom; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(value: string): Date {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

export function startOfISOWeek(d: Date): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - day);
  return copy;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function isoWeekMeta(monday: Date): { year: number; week: number; label: string } {
  const thursday = addDays(monday, 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week1 = startOfISOWeek(jan4);
  const days =
    (Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()) -
      Date.UTC(week1.getFullYear(), week1.getMonth(), week1.getDate())) /
    86400000;
  const week = days / 7 + 1;
  return { year, week, label: `W${week}` };
}

export function readZoom(key: string, fallback: PlanZoom = "week"): PlanZoom {
  try {
    const value = localStorage.getItem(key);
    if (value === "day" || value === "week" || value === "month") return value;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function writeZoom(key: string, zoom: PlanZoom): void {
  try {
    localStorage.setItem(key, zoom);
  } catch {
    /* ignore */
  }
}

export function taskDueOn(task: { due_on?: string | null; week_start: string }): string {
  return (task.due_on || task.week_start).slice(0, 10);
}

export function projectColumnKey(d: Date, zoom: PlanZoom): string {
  if (zoom === "day") return ymd(d);
  if (zoom === "week") return ymd(startOfISOWeek(d));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function projectTaskColumnKey(dueOn: string, zoom: PlanZoom): string {
  return projectColumnKey(parseYmd(dueOn), zoom);
}

export const PLAN_SPAN_PAD = 3;

export function addPlanPeriods(d: Date, zoom: PlanZoom, n: number): Date {
  const start = alignAnchor(d, zoom);
  if (zoom === "day") return addDays(start, n);
  if (zoom === "week") return addDays(start, n * 7);
  return new Date(start.getFullYear(), start.getMonth() + n, 1);
}

export function projectColumns(anchor: Date, zoom: PlanZoom): Date[] {
  const count = ZOOM_COUNTS[zoom];
  if (zoom === "day") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    return Array.from({ length: count }, (_, i) => addDays(start, i));
  }
  if (zoom === "week") {
    const start = startOfISOWeek(anchor);
    return Array.from({ length: count }, (_, i) => addDays(start, i * 7));
  }
  const start = startOfMonth(anchor);
  return Array.from({ length: count }, (_, i) => new Date(start.getFullYear(), start.getMonth() + i, 1));
}

export function projectColumnsSpanning(dueDates: string[], zoom: PlanZoom, pad = PLAN_SPAN_PAD): Date[] {
  const current = todayAnchor(zoom);
  let start = current;
  let end = current;
  if (dueDates.length) {
    start = alignAnchor(parseYmd(dueDates[0]), zoom);
    end = start;
    for (const value of dueDates) {
      const col = alignAnchor(parseYmd(value), zoom);
      if (col.getTime() < start.getTime()) start = col;
      if (col.getTime() > end.getTime()) end = col;
    }
  }
  start = addPlanPeriods(start, zoom, -pad);
  end = addPlanPeriods(end, zoom, pad);
  const cols: Date[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addPlanPeriods(d, zoom, 1)) {
    cols.push(d);
  }
  return cols;
}

export function templateColumnsSpanning(colIndexes: number[], pad = PLAN_SPAN_PAD): number[] {
  let min = 0;
  let max = 0;
  if (colIndexes.length) {
    min = colIndexes[0];
    max = colIndexes[0];
    for (const col of colIndexes) {
      if (col < min) min = col;
      if (col > max) max = col;
    }
  }
  const start = Math.max(0, min - pad);
  const end = Math.max(start, max + pad);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export function dropDueOn(fromDueOn: string, column: Date, zoom: PlanZoom): string {
  const from = parseYmd(fromDueOn);
  if (zoom === "day") return ymd(column);
  if (zoom === "week") return ymd(addDays(startOfISOWeek(column), weekdayIndex(from)));
  const year = column.getFullYear();
  const month = column.getMonth();
  const day = Math.min(from.getDate(), lastDayOfMonth(year, month));
  return ymd(new Date(year, month, day));
}

export function newTaskDueOn(column: Date, zoom: PlanZoom): string {
  if (zoom === "day") return ymd(column);
  if (zoom === "week") return ymd(startOfISOWeek(column));
  return ymd(startOfMonth(column));
}

export function dayDelta(from: string, to: string): number {
  return Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / 86400000);
}

export function stepAnchor(anchor: Date, zoom: PlanZoom, dir: -1 | 1): Date {
  const count = ZOOM_COUNTS[zoom];
  if (zoom === "day") return addDays(anchor, dir * count);
  if (zoom === "week") return addDays(startOfISOWeek(anchor), dir * count * 7);
  return new Date(anchor.getFullYear(), anchor.getMonth() + dir * count, 1);
}

export function todayColumnIndex(zoom: PlanZoom): number {
  return zoom === "month" ? 1 : 2;
}

export function todayAnchor(zoom: PlanZoom): Date {
  const now = new Date();
  if (zoom === "month") return startOfMonth(now);
  if (zoom === "week") return startOfISOWeek(now);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function todayWindowAnchor(zoom: PlanZoom): Date {
  const today = todayAnchor(zoom);
  const back = todayColumnIndex(zoom);
  if (zoom === "day") return addDays(today, -back);
  if (zoom === "week") return addDays(today, -back * 7);
  return new Date(today.getFullYear(), today.getMonth() - back, 1);
}

export function isCurrentPlanColumn(col: Date, zoom: PlanZoom): boolean {
  return projectColumnKey(col, zoom) === projectColumnKey(new Date(), zoom);
}

export function alignAnchor(anchor: Date, zoom: PlanZoom): Date {
  if (zoom === "day") return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  if (zoom === "week") return startOfISOWeek(anchor);
  return startOfMonth(anchor);
}

export function formatProjectHeader(
  col: Date,
  zoom: PlanZoom,
  prev: Date | null,
): { year?: string; title: string; sub?: string } {
  if (zoom === "day") {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const showYear = !prev || prev.getFullYear() !== col.getFullYear();
    return {
      year: showYear ? String(col.getFullYear()) : undefined,
      title: days[weekdayIndex(col)],
      sub: `${col.getDate()}/${col.getMonth() + 1}`,
    };
  }
  if (zoom === "week") {
    const meta = isoWeekMeta(col);
    const prevMeta = prev ? isoWeekMeta(prev) : null;
    return {
      year: prevMeta?.year !== meta.year ? String(meta.year) : undefined,
      title: meta.label,
      sub: `${col.getDate()}/${col.getMonth() + 1}`,
    };
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const showYear = !prev || prev.getFullYear() !== col.getFullYear();
  return {
    year: showYear ? String(col.getFullYear()) : undefined,
    title: months[col.getMonth()],
  };
}

export function formatChipDay(dueOn: string): string {
  const d = parseYmd(dueOn);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `${days[weekdayIndex(d)]} ${d.getDate()}`;
}

export function templateUnit(zoom: PlanZoom): number {
  if (zoom === "day") return 1;
  if (zoom === "week") return 7;
  return 28;
}

export function templateColOf(dayOffset: number, zoom: PlanZoom): number {
  return Math.floor(Math.max(0, dayOffset) / templateUnit(zoom));
}

export function templateDropOffset(from: number, col: number, zoom: PlanZoom): number {
  const unit = templateUnit(zoom);
  if (zoom === "day") return Math.max(0, col);
  return Math.max(0, col * unit + (Math.max(0, from) % unit));
}

export function templateNewOffset(col: number, zoom: PlanZoom): number {
  return Math.max(0, col * templateUnit(zoom));
}

export function templateHeading(
  col: number,
  zoom: PlanZoom,
  direction: ScheduleDirection = "forward",
  deliveryCol = 0,
): string {
  const suffix = zoom === "day" ? "d" : zoom === "week" ? "w" : "m";
  if (direction === "backward") {
    const delta = deliveryCol - col;
    if (delta === 0) return "Delivery";
    return delta > 0 ? `-${delta}${suffix}` : `+${-delta}${suffix}`;
  }
  if (col === 0) return "Start";
  return `+${col}${suffix}`;
}

export function localYmdFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return ymd(d);
}

export function ymdFromLocalInput(value: string): string | null {
  if (!value) return null;
  const slice = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(slice) ? slice : null;
}
