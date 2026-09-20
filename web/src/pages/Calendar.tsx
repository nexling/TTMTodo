import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  type Attachment,
  type Bucket,
  type Item,
  type OutlookEvent,
} from "../api";
import {
  LightboxOverlay,
  TreeCards,
  lightboxFor,
  type Lightbox,
} from "../components/ItemCard";
import { subscribePush } from "../push";
import { ShiftRelatedDialog, useShiftFlow } from "../components/ShiftRelatedDialog";
import { bucketOptionLabel, walkBucketTree } from "../bucketTree";
import { saveItemWithPlanDue } from "../planDue";
import { useLiveReload } from "../live";
import SidebarResizeHandle from "../components/SidebarResizeHandle";
import { useDepartmentWorkNav } from "../planAccess";

const CAL_VIEW_KEY = "magictodo:cal-view";
const CAL_BUCKET_KEY = "magictodo:cal-add-bucket";
const TASK_MINUTES = 30;
const SNAP_MINUTES = 15;
const HOUR_PX = 48;
const HOURS = 24;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const VIEWS = [
  { id: "day", label: "Day" },
  { id: "days3", label: "3 days" },
  { id: "workweek", label: "Work week" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
] as const;

type CalView = (typeof VIEWS)[number]["id"];

type CalEvent = {
  key: string;
  kind: "task" | "outlook";
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color: string;
  itemId?: string;
  bucketId?: string;
  inbox?: boolean;
  item?: Item;
  webLink?: string | null;
  location?: string;
  calendarName?: string;
};

type LaidOut = CalEvent & { col: number; cols: number };

type Popover = {
  event: CalEvent;
  x: number;
  y: number;
};

type Compose = {
  x: number;
  y: number;
};

type CtxMenu = {
  due: Date;
  x: number;
  y: number;
};

function readView(): CalView {
  try {
    const value = localStorage.getItem(CAL_VIEW_KEY);
    if (VIEWS.some((row) => row.id === value)) return value as CalView;
  } catch {
    /* ignore */
  }
  return "week";
}

function persistView(view: CalView) {
  try {
    localStorage.setItem(CAL_VIEW_KEY, view);
  } catch {
    /* ignore */
  }
}

function readCalBucket(buckets: Bucket[]): string {
  try {
    const id = localStorage.getItem(CAL_BUCKET_KEY);
    if (id && buckets.some((b) => b.id === id)) return id;
  } catch {
    /* ignore */
  }
  return buckets.find((b) => b.is_inbox)?.id ?? buckets[0]?.id ?? "";
}

function persistCalBucket(id: string) {
  try {
    localStorage.setItem(CAL_BUCKET_KEY, id);
  } catch {
    /* ignore */
  }
}

function dueFromClick(day: Date, column: HTMLElement, clientY: number): Date {
  const rect = column.getBoundingClientRect();
  const height = rect.height || HOURS * HOUR_PX;
  const ratio = (clientY - rect.top) / height;
  const maxStart = HOURS * 60 - TASK_MINUTES;
  let minutes = Math.round((ratio * HOURS * 60) / SNAP_MINUTES) * SNAP_MINUTES;
  minutes = Math.max(0, Math.min(maxStart, minutes));
  const next = startOfDay(day);
  next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return next;
}

function dueAtNine(day: Date): Date {
  const next = startOfDay(day);
  next.setHours(9, 0, 0, 0);
  return next;
}

function startOfDay(d: Date): Date {
  const next = new Date(d);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function addMonths(d: Date, n: number): Date {
  const next = new Date(d);
  next.setMonth(next.getMonth() + n);
  return next;
}

function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function flattenItems(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    out.push(item);
    if (item.subtasks?.length) out.push(...flattenItems(item.subtasks));
  }
  return out;
}

function findItem(items: Item[], id: string): Item | null {
  for (const it of items) {
    if (it.id === id) return it;
    const nested = findItem(it.subtasks ?? [], id);
    if (nested) return nested;
  }
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function recurPreset(item: Item): string {
  if (!item.recur_interval || !item.recur_unit) return "";
  if (item.recur_interval === 1 && item.recur_unit === "day") return "daily";
  if (item.recur_interval === 1 && item.recur_unit === "week") return "weekly";
  if (item.recur_interval === 1 && item.recur_unit === "month") return "monthly";
  if (item.recur_interval === 1 && item.recur_unit === "year") return "yearly";
  return "custom";
}

function recurPayload(
  preset: string,
  n: string,
  unit: "day" | "week",
): { recur_interval: number | null; recur_unit: "day" | "week" | "month" | "year" | null } {
  if (!preset) return { recur_interval: null, recur_unit: null };
  if (preset === "daily") return { recur_interval: 1, recur_unit: "day" };
  if (preset === "weekly") return { recur_interval: 1, recur_unit: "week" };
  if (preset === "monthly") return { recur_interval: 1, recur_unit: "month" };
  if (preset === "yearly") return { recur_interval: 1, recur_unit: "year" };
  return { recur_interval: Math.max(1, Number(n) || 1), recur_unit: unit };
}

function dueOverlapsRange(item: Item, rangeStart: Date, rangeEnd: Date): boolean {
  if (!item.due_at) return false;
  const start = new Date(item.due_at);
  if (Number.isNaN(start.getTime())) return false;
  const end = new Date(start.getTime() + TASK_MINUTES * 60 * 1000);
  return start.getTime() < rangeEnd.getTime() && end.getTime() > rangeStart.getTime();
}

function splitDump(text: string): { title?: string; notes?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const nl = trimmed.indexOf("\n");
  if (nl === -1) return { title: trimmed.slice(0, 500) };
  const first = trimmed.slice(0, nl).trim();
  const rest = trimmed.slice(nl + 1).trim();
  return {
    title: first ? first.slice(0, 500) : undefined,
    notes: rest || undefined,
  };
}

function isCoarsePointer(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

function insertNewline(el: HTMLTextAreaElement, value: string, setValue: (next: string) => void): void {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const next = value.slice(0, start) + "\n" + value.slice(end);
  setValue(next);
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = start + 1;
  });
}

function composerEnterKey(
  e: KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  setValue: (next: string) => void,
  onSubmit: () => void,
): void {
  if (e.key !== "Enter") return;
  if (isCoarsePointer()) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    e.preventDefault();
    insertNewline(e.currentTarget, value, setValue);
    return;
  }
  e.preventDefault();
  onSubmit();
}

function rangeForView(anchor: Date, view: CalView): { start: Date; end: Date; days: Date[] } {
  if (view === "day") {
    const start = startOfDay(anchor);
    return { start, end: addDays(start, 1), days: [start] };
  }
  if (view === "days3") {
    const start = startOfDay(anchor);
    return { start, end: addDays(start, 3), days: [start, addDays(start, 1), addDays(start, 2)] };
  }
  if (view === "workweek") {
    const start = startOfWeek(anchor);
    return {
      start,
      end: addDays(start, 5),
      days: [0, 1, 2, 3, 4].map((n) => addDays(start, n)),
    };
  }
  if (view === "week") {
    const start = startOfWeek(anchor);
    return {
      start,
      end: addDays(start, 7),
      days: [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(start, n)),
    };
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  return { start, end: addDays(start, 42), days };
}

function titleForRange(anchor: Date, view: CalView, days: Date[]): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  if (view === "month") {
    return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  if (view === "day") {
    return anchor.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return "";
  return `${first.toLocaleDateString(undefined, opts)} – ${last.toLocaleDateString(undefined, opts)}`;
}

function formatHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function overlapsDay(event: CalEvent, day: Date): boolean {
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  return event.start.getTime() < to && event.end.getTime() > from;
}

function clipToDay(event: CalEvent, day: Date): { start: Date; end: Date } {
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  return {
    start: new Date(Math.max(event.start.getTime(), from)),
    end: new Date(Math.min(event.end.getTime(), to)),
  };
}

function layoutTimed(events: CalEvent[], day: Date): LaidOut[] {
  const timed = events
    .filter((ev) => !ev.allDay && overlapsDay(ev, day))
    .map((ev) => {
      const clip = clipToDay(ev, day);
      return { ...ev, start: clip.start, end: clip.end };
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  const laid: LaidOut[] = [];
  let cluster: LaidOut[] = [];
  let clusterEnd = 0;
  let used = 0;

  function flush() {
    for (const row of cluster) row.cols = Math.max(used, 1);
    cluster = [];
    used = 0;
  }

  for (const ev of timed) {
    if (cluster.length && ev.start.getTime() >= clusterEnd) flush();
    const taken = new Set(cluster.filter((row) => row.end.getTime() > ev.start.getTime()).map((row) => row.col));
    let col = 0;
    while (taken.has(col)) col += 1;
    const next: LaidOut = { ...ev, col, cols: 1 };
    cluster.push(next);
    laid.push(next);
    used = Math.max(used, col + 1);
    clusterEnd = Math.max(clusterEnd, ev.end.getTime());
  }
  flush();
  return laid;
}

function taskEvents(items: Item[], buckets: Bucket[]): CalEvent[] {
  const byId = new Map(buckets.map((b) => [b.id, b]));
  const out: CalEvent[] = [];
  for (const item of flattenItems(items)) {
    if (!item.due_at) continue;
    const start = new Date(item.due_at);
    if (Number.isNaN(start.getTime())) continue;
    const bucket = byId.get(item.bucket_id);
    const end = new Date(start.getTime() + TASK_MINUTES * 60 * 1000);
    out.push({
      key: `task:${item.id}`,
      kind: "task",
      title: item.title?.trim() || "Untitled",
      start,
      end,
      allDay: false,
      color: bucket?.color || "#e8a54b",
      itemId: item.id,
      bucketId: item.bucket_id,
      inbox: Boolean(bucket?.is_inbox),
      item,
    });
  }
  return out;
}

function outlookToEvents(rows: OutlookEvent[]): CalEvent[] {
  const out: CalEvent[] = [];
  for (const row of rows) {
    const start = new Date(row.start);
    const end = new Date(row.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    out.push({
      key: `outlook:${row.calendar_id}:${row.id}`,
      kind: "outlook",
      title: row.subject?.trim() || "(no title)",
      start,
      end: end.getTime() > start.getTime() ? end : new Date(start.getTime() + TASK_MINUTES * 60 * 1000),
      allDay: Boolean(row.is_all_day),
      color: row.color || "#6a8caf",
      webLink: row.web_link,
      location: row.location,
      calendarName: row.calendar_name,
    });
  }
  return out;
}

function taskHref(event: CalEvent): string {
  if (!event.itemId) return "/";
  if (event.inbox || !event.bucketId) return `/?item=${event.itemId}`;
  return `/b/${event.bucketId}?item=${event.itemId}`;
}

function minutesFromMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

export default function Calendar() {
  const navigate = useNavigate();
  const showDepartmentWork = useDepartmentWorkNav();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [outlook, setOutlook] = useState<OutlookEvent[]>([]);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<CalView>(readView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [now, setNow] = useState(() => new Date());
  const [popover, setPopover] = useState<Popover | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [composeText, setComposeText] = useState("");
  const [composeDue, setComposeDue] = useState("");
  const [composeBucket, setComposeBucket] = useState("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const { shiftPrompt, shiftBusy, beginShiftFlow, resolveShiftPrompt } = useShiftFlow();
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editLead, setEditLead] = useState("");
  const [editRecur, setEditRecur] = useState("");
  const [editRecurN, setEditRecurN] = useState("2");
  const [editRecurUnit, setEditRecurUnit] = useState<"day" | "week">("day");
  const [addingStepFor, setAddingStepFor] = useState<string | null>(null);
  const [stepText, setStepText] = useState("");
  const [remarkableConfigured, setRemarkableConfigured] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);

  const { start, end, days } = useMemo(() => rangeForView(anchor, view), [anchor, view]);
  const tasks = useMemo(() => taskEvents(items, buckets), [items, buckets]);
  const events = useMemo(() => [...tasks, ...outlookToEvents(outlook)], [tasks, outlook]);
  const allOpenCount = buckets.filter((b) => !b.parent_id).reduce((sum, b) => sum + b.open_count, 0);
  const rangeTitle = titleForRange(anchor, view, days);

  useEffect(() => {
    void api
      .buckets()
      .then(setBuckets)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load buckets"));
    void api
      .items(undefined, false)
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load items"));
    void api
      .remarkableStatus()
      .then((status) => setRemarkableConfigured(Boolean(status.configured)))
      .catch(() => setRemarkableConfigured(false));
  }, []);

  useEffect(() => {
    const from = start.toISOString();
    const to = end.toISOString();
    void Promise.all([
      api.outlookEvents(from, to).catch(() => [] as OutlookEvent[]),
      api.icalEvents(from, to).catch(() => [] as OutlookEvent[]),
    ]).then(([graph, ics]) => setOutlook([...graph, ...ics]));
  }, [start, end]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (view === "month" || scrolled.current) return;
    const node = gridRef.current;
    if (!node) return;
    const hours = now.getHours() + now.getMinutes() / 60;
    node.scrollTop = Math.max(0, (hours - 7) * HOUR_PX);
    scrolled.current = true;
  }, [view, now, days.length]);

  useLiveReload(
    (event) => event.channel === "inbox",
    () => {
      void refreshItems();
    },
  );

  function setCalView(next: CalView) {
    setView(next);
    persistView(next);
    scrolled.current = false;
  }

  function goToday() {
    setAnchor(startOfDay(new Date()));
    scrolled.current = false;
  }

  function goPrev() {
    if (view === "month") setAnchor(addMonths(anchor, -1));
    else if (view === "day") setAnchor(addDays(anchor, -1));
    else if (view === "days3") setAnchor(addDays(anchor, -3));
    else setAnchor(addDays(anchor, -7));
    scrolled.current = false;
  }

  function goNext() {
    if (view === "month") setAnchor(addMonths(anchor, 1));
    else if (view === "day") setAnchor(addDays(anchor, 1));
    else if (view === "days3") setAnchor(addDays(anchor, 3));
    else setAnchor(addDays(anchor, 7));
    scrolled.current = false;
  }

  function closePopover() {
    setPopover(null);
    setEditingId(null);
    setAddingStepFor(null);
    setStepText("");
    setLightbox(null);
  }

  function closeComposer() {
    setCompose(null);
    setComposeText("");
    setComposeBusy(false);
  }

  function openComposer(due: Date, x: number, y: number) {
    closePopover();
    setCtxMenu(null);
    setCompose({ x, y });
    setComposeText("");
    setComposeDue(toLocalInput(due.toISOString()));
    setComposeBucket(readCalBucket(buckets));
  }

  function onDayClick(day: Date, e: MouseEvent<HTMLDivElement>) {
    openComposer(dueFromClick(day, e.currentTarget, e.clientY), e.clientX, e.clientY);
  }

  function onDayContextMenu(day: Date, e: MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    openComposer(dueFromClick(day, e.currentTarget, e.clientY), e.clientX, e.clientY);
  }

  function onBlockContextMenu(day: Date, e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    const column = e.currentTarget.closest(".cal-day") as HTMLElement | null;
    if (!column) return;
    closePopover();
    setCompose(null);
    setCtxMenu({
      due: dueFromClick(day, column, e.clientY),
      x: e.clientX,
      y: e.clientY,
    });
  }

  function onMonthCellClick(day: Date, e: MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("button")) return;
    openComposer(dueAtNine(day), e.clientX, e.clientY);
  }

  function onMonthCellContextMenu(day: Date, e: MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    openComposer(dueAtNine(day), e.clientX, e.clientY);
  }

  function onChipContextMenu(day: Date, e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    closePopover();
    setCompose(null);
    setCtxMenu({ due: dueAtNine(day), x: e.clientX, y: e.clientY });
  }

  async function submitCompose(e?: FormEvent) {
    e?.preventDefault();
    if (!composeText.trim() || !composeBucket || composeBusy) return;
    const dueAt = fromLocalInput(composeDue);
    if (!dueAt) {
      setError("Pick a due date");
      return;
    }
    setComposeBusy(true);
    setError("");
    try {
      const form = new FormData();
      const dumped = splitDump(composeText);
      if (dumped.title) form.append("title", dumped.title);
      if (dumped.notes) form.append("notes", dumped.notes);
      form.append("source", "web");
      form.append("bucket_id", composeBucket);
      form.append("due_at", dueAt);
      await api.createItem(form);
      persistCalBucket(composeBucket);
      closeComposer();
      await refreshItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add item");
    } finally {
      setComposeBusy(false);
    }
  }

  async function refreshItems(): Promise<Item[]> {
    const [nextBuckets, nextItems] = await Promise.all([api.buckets(), api.items(undefined, false)]);
    setBuckets(nextBuckets);
    setItems(nextItems);
    return nextItems;
  }

  function syncPopover(nextItems: Item[], itemId: string | undefined) {
    if (!itemId) return;
    const found = findItem(nextItems, itemId);
    if (!found || !dueOverlapsRange(found, start, end)) {
      closePopover();
      return;
    }
    setPopover((prev) =>
      prev
        ? {
            ...prev,
            event: {
              ...prev.event,
              item: found,
              title: found.title?.trim() || "Untitled",
              start: new Date(found.due_at as string),
              end: new Date(new Date(found.due_at as string).getTime() + TASK_MINUTES * 60 * 1000),
            },
          }
        : prev,
    );
  }

  function openEvent(event: CalEvent, e: MouseEvent) {
    e.stopPropagation();
    setCompose(null);
    setCtxMenu(null);
    setEditingId(null);
    setAddingStepFor(null);
    setStepText("");
    setFolded(new Set());
    if (event.kind === "task" && event.itemId) {
      const found = findItem(items, event.itemId) ?? event.item;
      setPopover({ event: { ...event, item: found }, x: e.clientX, y: e.clientY });
      return;
    }
    setPopover({ event, x: e.clientX, y: e.clientY });
  }

  async function toggle(item: Item) {
    const interval = item.recur_interval;
    const unit = item.recur_unit;
    const due = item.due_at;
    try {
      if (item.status === "open" && interval && unit && due) {
        await api.patchItem(item.id, { status: "done" });
      } else {
        await api.patchItem(item.id, { status: item.status === "open" ? "done" : "open" });
      }
      const next = await refreshItems();
      syncPopover(next, popover?.event.itemId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update");
    }
  }

  async function move(item: Item, dest: string) {
    if (item.plan_task_id || dest === item.bucket_id) return;
    await api.patchItem(item.id, { bucket_id: dest });
    const next = await refreshItems();
    syncPopover(next, popover?.event.itemId);
  }

  async function later(item: Item, minutes: number | null) {
    const remind_at = minutes == null ? null : new Date(Date.now() + minutes * 60_000).toISOString();
    await api.patchItem(item.id, { remind_at });
    if (minutes) {
      try {
        await subscribePush();
      } catch {
        /* ignore */
      }
    }
    const next = await refreshItems();
    syncPopover(next, popover?.event.itemId);
  }

  async function remove(item: Item) {
    const hasKids = (item.subtasks ?? []).length > 0;
    const msg = hasKids
      ? "Delete this item and its steps?"
      : item.parent_id
        ? "Delete this step?"
        : "Delete this item?";
    if (!confirm(msg)) return;
    await api.deleteItem(item.id);
    const next = await refreshItems();
    if (popover?.event.itemId === item.id) closePopover();
    else syncPopover(next, popover?.event.itemId);
  }

  async function sendToRemarkable(item: Item) {
    setError("");
    try {
      await api.sendToRemarkable(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send to reMarkable");
    }
  }

  function startEdit(item: Item) {
    setEditingId(item.id);
    setEditTitle(item.title ?? "");
    setEditNotes(item.notes ?? "");
    setEditDue(toLocalInput(item.due_at ?? null));
    setEditLead(item.reminder_lead_minutes ? String(item.reminder_lead_minutes) : "");
    const preset = recurPreset(item);
    setEditRecur(preset);
    setEditRecurN(preset === "custom" && item.recur_interval ? String(item.recur_interval) : "2");
    setEditRecurUnit(item.recur_unit === "week" ? "week" : "day");
    setAddingStepFor(null);
  }

  async function saveEdit() {
    if (!editingId) return;
    const item = findItem(items, editingId);
    const dueAt = fromLocalInput(editDue);
    const lead = dueAt && editLead ? Number(editLead) : null;
    const recur = dueAt
      ? recurPayload(editRecur, editRecurN, editRecurUnit)
      : { recur_interval: null, recur_unit: null };
    const patch = async (skipDueAt: boolean) => {
      await api.patchItem(
        editingId,
        skipDueAt
          ? {
              title: editTitle,
              notes: editNotes,
              reminder_lead_minutes: lead,
              recur_interval: recur.recur_interval,
              recur_unit: recur.recur_unit,
            }
          : {
              title: editTitle,
              notes: editNotes,
              due_at: dueAt,
              reminder_lead_minutes: lead,
              recur_interval: recur.recur_interval,
              recur_unit: recur.recur_unit,
            },
      );
      setEditingId(null);
      const next = await refreshItems();
      syncPopover(next, popover?.event.itemId);
    };
    if (item?.plan_task_id) {
      try {
        const result = await saveItemWithPlanDue({
          item,
          dueAt,
          localDueInput: editDue,
          patch,
          beginShiftFlow,
        });
        if (result === "prompted") return;
        return;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save item");
        return;
      }
    }
    await patch(false);
  }

  function editKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditingId(null);
      return;
    }
    const isNotes = e.currentTarget.placeholder === "Notes";
    composerEnterKey(e, isNotes ? editNotes : editTitle, isNotes ? setEditNotes : setEditTitle, () => void saveEdit());
  }

  function stepKey(e: KeyboardEvent<HTMLTextAreaElement>, parent: Item) {
    if (e.key === "Escape") {
      e.preventDefault();
      setAddingStepFor(null);
      setStepText("");
      return;
    }
    composerEnterKey(e, stepText, setStepText, () => void saveStep(parent));
  }

  async function saveStep(parent: Item) {
    if (!stepText.trim()) return;
    const form = new FormData();
    const dumped = splitDump(stepText);
    if (dumped.title) form.append("title", dumped.title);
    if (dumped.notes) form.append("notes", dumped.notes);
    form.append("parent_id", parent.id);
    form.append("source", "web");
    await api.createItem(form);
    setStepText("");
    setAddingStepFor(null);
    const next = await refreshItems();
    syncPopover(next, popover?.event.itemId);
  }

  async function attachFiles(item: Item, incoming: File[]) {
    if (!incoming.length) return;
    setError("");
    try {
      for (const file of incoming) await api.addAttachment(item.id, file);
      const next = await refreshItems();
      syncPopover(next, popover?.event.itemId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach file");
    }
  }

  async function detachFile(item: Item, attachmentId: string) {
    setError("");
    try {
      await api.deleteAttachment(item.id, attachmentId);
      const next = await refreshItems();
      syncPopover(next, popover?.event.itemId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove file");
    }
  }

  const previewItem = popover?.event.kind === "task" ? popover.event.item ?? findItem(items, popover.event.itemId || "") : null;
  const cardProps = previewItem
    ? {
        items: [previewItem],
        buckets,
        allView: true,
        allowReorder: false,
        draggingId: null,
        dropItemId: null,
        dropFileItemId: null,
        dragReadyId: null,
        editingId,
        editTitle,
        editNotes,
        editDue,
        editLead,
        editRecur,
        editRecurN,
        editRecurUnit,
        addingStepFor,
        stepText,
        onToggle: (item: Item) => void toggle(item),
        onMove: (item: Item, dest: string) => void move(item, dest),
        onReparent: () => undefined,
        onRemove: (item: Item) => void remove(item),
        onToggleFold: (item: Item) => {
          setFolded((prev) => {
            const next = new Set(prev);
            if (next.has(item.id)) next.delete(item.id);
            else next.add(item.id);
            return next;
          });
        },
        onDragStart: (e: DragEvent) => e.preventDefault(),
        onDragEnd: () => undefined,
        onCardMouseDown: () => undefined,
        onCardDragOver: (e: DragEvent) => e.preventDefault(),
        onCardDragLeave: () => undefined,
        onCardDrop: (e: DragEvent) => e.preventDefault(),
        onEditStart: startEdit,
        onEditTitle: setEditTitle,
        onEditNotes: setEditNotes,
        onEditDue: setEditDue,
        onEditLead: setEditLead,
        onEditRecur: setEditRecur,
        onEditRecurN: setEditRecurN,
        onEditRecurUnit: setEditRecurUnit,
        onEditSave: () => void saveEdit(),
        onEditCancel: () => setEditingId(null),
        onEditKey: editKey,
        onAddStep: (parent: Item) => {
          setAddingStepFor(parent.id);
          setStepText("");
          setEditingId(null);
          setFolded((prev) => {
            if (!prev.has(parent.id)) return prev;
            const next = new Set(prev);
            next.delete(parent.id);
            return next;
          });
        },
        onStepText: setStepText,
        onStepKey: stepKey,
        onStepSave: (parent: Item) => void saveStep(parent),
        onStepCancel: () => {
          setAddingStepFor(null);
          setStepText("");
        },
        onLightbox: (att: Attachment) => setLightbox(lightboxFor(att)),
        onAttach: (item: Item, incoming: File[]) => void attachFiles(item, incoming),
        onDetach: (item: Item, attachmentId: string) => void detachFile(item, attachmentId),
        onSendRemarkable: (item: Item) => void sendToRemarkable(item),
        onLater: (item: Item, minutes: number | null) => void later(item, minutes),
        remarkableConfigured,
      }
    : null;

  function openDay(day: Date) {
    setAnchor(startOfDay(day));
    setCalView("day");
  }

  const timeHeight = HOURS * HOUR_PX;
  const nowTop = (minutesFromMidnight(now) / (HOURS * 60)) * timeHeight;

  return (
    <div className="shell">
      {shiftPrompt ? (
        <ShiftRelatedDialog
          prompt={shiftPrompt}
          busy={shiftBusy}
          onResolve={(move) => void resolveShiftPrompt(move, setError)}
        />
      ) : null}
      <div className={`overlay${menuOpen ? " show" : ""}`} onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <div className="sidebar-top">
          <h1 className="brand">
            TTM-<span>Todo</span>
          </h1>
        </div>
        <Link className="bucket-link" to="/all" onClick={() => setMenuOpen(false)}>
          All
          <span className="count">{allOpenCount}</span>
        </Link>
        <Link className="bucket-link" to="/done" onClick={() => setMenuOpen(false)}>
          Done today
        </Link>
        <Link className="bucket-link active" to="/calendar" onClick={() => setMenuOpen(false)}>
          Calendar
        </Link>
        <Link className="bucket-link" to="/org" onClick={() => setMenuOpen(false)}>
          Organization
        </Link>
        {showDepartmentWork ? (
          <Link className="bucket-link" to="/org/departments" onClick={() => setMenuOpen(false)}>
            Department work
          </Link>
        ) : null}
        {walkBucketTree(buckets).map(({ bucket: b, depth }) => (
          <Link
            key={b.id}
            className="bucket-link"
            style={{ ["--depth" as string]: depth }}
            to={b.is_inbox ? "/" : `/b/${b.id}`}
            onClick={() => setMenuOpen(false)}
          >
            <span className="dot" style={{ background: b.color }} />
            {b.name}
            <span className="count">{b.open_count}</span>
          </Link>
        ))}
        <div className="sidebar-foot">
          <Link className="nav-btn" to="/settings" onClick={() => setMenuOpen(false)}>
            Settings
          </Link>
        </div>
        <SidebarResizeHandle />
      </aside>

      <main className="main calendar">
        <div className="main-head">
          <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open buckets">
            Buckets
          </button>
          <h1>Calendar</h1>
          <div className="cal-toolbar">
            <button className="btn ghost small" type="button" onClick={goToday}>
              Today
            </button>
            <button className="btn ghost small" type="button" onClick={goPrev} aria-label="Previous">
              ‹
            </button>
            <button className="btn ghost small" type="button" onClick={goNext} aria-label="Next">
              ›
            </button>
            <span className="cal-range">{rangeTitle}</span>
            <div className="cal-views">
              {VIEWS.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`btn ghost small${view === row.id ? " on" : ""}`}
                  onClick={() => setCalView(row.id)}
                >
                  {row.label}
                </button>
              ))}
            </div>
            <Link className="btn ghost small" to="/settings#outlook-tasks">
              Show in Outlook
            </Link>
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}

        {view === "month" ? (
          <div className="cal-month">
            <div className="cal-month-weekdays">
              {WEEKDAYS.map((name) => (
                <div key={name}>{name}</div>
              ))}
            </div>
            <div className="cal-month-grid">
              {days.map((day) => {
                const inMonth = day.getMonth() === anchor.getMonth();
                const today = isSameDay(day, now);
                const dayEvents = events
                  .filter((ev) => overlapsDay(ev, day))
                  .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
                const shown = dayEvents.slice(0, 4);
                const extra = dayEvents.length - shown.length;
                return (
                  <div
                    key={day.toISOString()}
                    className={`cal-month-cell${inMonth ? "" : " muted"}${today ? " today" : ""}`}
                    onClick={(e) => onMonthCellClick(day, e)}
                    onContextMenu={(e) => onMonthCellContextMenu(day, e)}
                  >
                    <button type="button" className="cal-month-num" onClick={() => openDay(day)}>
                      {day.getDate()}
                    </button>
                    <div className="cal-month-chips">
                      {shown.map((ev) => (
                        <button
                          key={ev.key}
                          type="button"
                          className={`cal-chip${ev.kind === "outlook" ? " outlook" : ""}`}
                          style={ev.kind === "task" ? { background: ev.color } : { borderColor: ev.color, color: ev.color }}
                          title={ev.title}
                          onClick={(e) => openEvent(ev, e)}
                          onContextMenu={(e) => onChipContextMenu(day, e)}
                        >
                          {ev.allDay ? ev.title : `${formatClock(ev.start)} ${ev.title}`}
                        </button>
                      ))}
                      {extra > 0 ? <div className="cal-more">+{extra} more</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="cal-scroll" ref={gridRef}>
            <div className="cal-time" style={{ ["--days" as string]: String(days.length) }}>
              <div className="cal-allday">
                <div className="cal-gutter">All day</div>
                {days.map((day) => {
                  const allDay = events.filter((ev) => ev.allDay && overlapsDay(ev, day));
                  return (
                    <div key={`all-${day.toISOString()}`} className="cal-allday-cell">
                      {allDay.map((ev) => (
                        <button
                          key={ev.key}
                          type="button"
                          className="cal-chip outlook"
                          style={{ borderColor: ev.color, color: ev.color }}
                          onClick={(e) => openEvent(ev, e)}
                        >
                          {ev.title}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div className="cal-head">
                <div className="cal-gutter" />
                {days.map((day) => (
                  <button
                    key={`h-${day.toISOString()}`}
                    type="button"
                    className={`cal-day-head${isSameDay(day, now) ? " today" : ""}`}
                    onClick={() => openDay(day)}
                  >
                    <span>{WEEKDAYS[(day.getDay() + 6) % 7]}</span>
                    <strong>{day.getDate()}</strong>
                  </button>
                ))}
              </div>
              <div className="cal-body" style={{ height: timeHeight }}>
                <div className="cal-hours">
                  {Array.from({ length: HOURS }, (_, h) => (
                    <div key={h} className="cal-hour" style={{ height: HOUR_PX }}>
                      {h === 0 ? "" : formatHour(h)}
                    </div>
                  ))}
                </div>
                {days.map((day) => {
                  const laid = layoutTimed(events, day);
                  const showNow = isSameDay(day, now);
                  return (
                    <div
                      key={`d-${day.toISOString()}`}
                      className="cal-day"
                      style={{ height: timeHeight }}
                      onClick={(e) => onDayClick(day, e)}
                      onContextMenu={(e) => onDayContextMenu(day, e)}
                    >
                      {Array.from({ length: HOURS }, (_, h) => (
                        <div key={h} className="cal-slot" style={{ top: h * HOUR_PX, height: HOUR_PX }} />
                      ))}
                      {showNow ? <div className="cal-now" style={{ top: nowTop }} /> : null}
                      {laid.map((ev) => {
                        const top = (minutesFromMidnight(ev.start) / (HOURS * 60)) * timeHeight;
                        const height = Math.max(
                          18,
                          ((ev.end.getTime() - ev.start.getTime()) / (HOURS * 60 * 60 * 1000)) * timeHeight,
                        );
                        const width = 100 / ev.cols;
                        const left = ev.col * width;
                        return (
                          <button
                            key={ev.key}
                            type="button"
                            className={`cal-block${ev.kind === "outlook" ? " outlook" : ""}`}
                            style={{
                              top,
                              height,
                              left: `calc(${left}% + 2px)`,
                              width: `calc(${width}% - 4px)`,
                              background: ev.kind === "task" ? ev.color : "transparent",
                              borderColor: ev.color,
                              color: ev.kind === "task" ? "#1a140a" : ev.color,
                            }}
                            title={`${ev.title} · ${formatClock(ev.start)}–${formatClock(ev.end)}`}
                            onClick={(e) => openEvent(ev, e)}
                            onContextMenu={(e) => onBlockContextMenu(day, e)}
                          >
                            <strong>{ev.title}</strong>
                            <span>
                              {formatClock(ev.start)}–{formatClock(ev.end)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {popover ? (
        <div className="cal-pop-scrim" onClick={() => closePopover()}>
          <div
            className={`cal-pop${previewItem && cardProps ? " task" : ""}`}
            style={{
              left: Math.max(12, Math.min(popover.x, window.innerWidth - (previewItem ? 452 : 292))),
              top: Math.max(12, Math.min(popover.y, window.innerHeight - (previewItem ? 80 : 180))),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {previewItem && cardProps ? (
              <>
                <div className="cal-pop-cards">
                  <TreeCards
                    item={previewItem}
                    depth={0}
                    viewDone={false}
                    folded={folded}
                    focusId={null}
                    cardProps={cardProps}
                  />
                </div>
                <div className="settings-actions">
                  <button className="btn small" type="button" onClick={() => navigate(taskHref(popover.event))}>
                    Go to task
                  </button>
                  <button className="btn ghost small" type="button" onClick={() => closePopover()}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>{popover.event.title}</h3>
                <p>
                  {popover.event.allDay
                    ? "All day"
                    : `${popover.event.start.toLocaleString()} – ${popover.event.end.toLocaleString()}`}
                </p>
                {popover.event.calendarName ? <p className="hint">{popover.event.calendarName}</p> : null}
                {popover.event.location ? <p className="hint">{popover.event.location}</p> : null}
                <div className="settings-actions">
                  {popover.event.webLink ? (
                    <a className="btn small" href={popover.event.webLink} target="_blank" rel="noreferrer">
                      Open in Outlook
                    </a>
                  ) : null}
                  <button className="btn ghost small" type="button" onClick={() => closePopover()}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      {ctxMenu ? (
        <div
          className="cal-pop-scrim"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        >
          <div
            className="color-menu cal-ctx"
            style={{
              left: Math.max(12, Math.min(ctxMenu.x, window.innerWidth - 180)),
              top: Math.max(12, Math.min(ctxMenu.y, window.innerHeight - 80)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="menu-item"
              type="button"
              onClick={() => openComposer(ctxMenu.due, ctxMenu.x, ctxMenu.y)}
            >
              Add new
            </button>
          </div>
        </div>
      ) : null}
      {compose ? (
        <div className="cal-pop-scrim" onClick={() => closeComposer()}>
          <div
            className="cal-pop compose"
            style={{
              left: Math.max(12, Math.min(compose.x, window.innerWidth - 352)),
              top: Math.max(12, Math.min(compose.y, window.innerHeight - 280)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <form className="cal-compose" onSubmit={(e) => void submitCompose(e)}>
              <textarea
                autoFocus
                placeholder="New todo…"
                value={composeText}
                onChange={(e) => setComposeText(e.target.value)}
                onKeyDown={(e) => composerEnterKey(e, composeText, setComposeText, () => void submitCompose())}
              />
              <label>
                Bucket
                <select value={composeBucket} onChange={(e) => setComposeBucket(e.target.value)} aria-label="Bucket">
                  {walkBucketTree(buckets).map(({ bucket: b, depth }) => (
                    <option key={b.id} value={b.id}>
                      {bucketOptionLabel(b, depth)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Due
                <input
                  type="datetime-local"
                  value={composeDue}
                  onChange={(e) => setComposeDue(e.target.value)}
                />
              </label>
              <div className="settings-actions">
                <button className="btn small" type="submit" disabled={composeBusy || !composeText.trim() || !composeBucket}>
                  {composeBusy ? "Adding…" : "Add"}
                </button>
                <button className="btn ghost small" type="button" onClick={() => closeComposer()}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {lightbox ? <LightboxOverlay lightbox={lightbox} onClose={() => setLightbox(null)} /> : null}
    </div>
  );
}
