import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, type Attachment, type Bucket, type Item } from "../api";
import { useLiveReload } from "../live";
import {
  FILE_ACCEPT,
  LightboxOverlay,
  REMINDER_LEADS,
  TreeCards,
  lightboxFor,
  type Lightbox,
} from "../components/ItemCard";
import { hasPushSubscription, showLocalNotification, subscribePush } from "../push";
import ColorPicker, { COLOR_PALETTE } from "../components/ColorPicker";
import { ShiftRelatedDialog, useShiftFlow } from "../components/ShiftRelatedDialog";
import { bucketChildren, bucketDescendantIds, bucketOptionLabel, walkBucketTree } from "../bucketTree";
import { saveItemWithPlanDue } from "../planDue";
import SidebarResizeHandle from "../components/SidebarResizeHandle";
import InboxResizeHandle from "../components/InboxResizeHandle";
import { useDepartmentWorkNav } from "../planAccess";
import { readInboxCompact, readInboxCompactNotes } from "../inboxPrefs";
import { filesFromDataTransfer } from "../clipboardFiles";

const TEXT_DRAG_SEL = ".title, .notes, a, input, textarea, button, select, iframe, pre, .thumbs";
const BUCKET_DRAG_MIME = "application/x-magictodo-bucket";
const ALL_SORT_KEY = "magictodo:all-sort";
const BUCKET_SORT_KEY = "magictodo:bucket-sort";
const DONE_BUCKET_KEY = "magictodo:done-bucket";
const FOLDED_KEY = "magictodo:folded";
const BUCKET_FOLDED_KEY = "magictodo:bucket-folded";
const BUCKET_SCOPE_PREFIX = "magictodo:bucket-scope:";
const MAX_TIMER_DELAY = 2 ** 31 - 1;

type AllSort = "due" | "bucket" | "color" | "created-new" | "created-old";
type BucketSort = "manual" | "due" | "created-new" | "created-old";
type RecurUnit = "day" | "week" | "month" | "year";

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

function flattenItems(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    out.push(item);
    if (item.subtasks?.length) out.push(...flattenItems(item.subtasks));
  }
  return out;
}

function readAllSort(): AllSort {
  try {
    const value = localStorage.getItem(ALL_SORT_KEY);
    if (value === "due" || value === "bucket" || value === "color" || value === "created-new" || value === "created-old") {
      return value;
    }
  } catch {
    /* ignore */
  }
  return "due";
}

function readBucketSort(): BucketSort {
  try {
    const value = localStorage.getItem(BUCKET_SORT_KEY);
    if (value === "manual" || value === "due" || value === "created-new" || value === "created-old") {
      return value;
    }
  } catch {
    /* ignore */
  }
  return "manual";
}

function readDoneBucket(): string {
  try {
    return localStorage.getItem(DONE_BUCKET_KEY) ?? "";
  } catch {
    /* ignore */
  }
  return "";
}

function readFolded(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLDED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function writeFolded(ids: Set<string>): void {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

function readBucketFolded(): Set<string> {
  try {
    const raw = localStorage.getItem(BUCKET_FOLDED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function writeBucketFolded(ids: Set<string>): void {
  try {
    localStorage.setItem(BUCKET_FOLDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

function readBucketScope(id: string): "all" | "active" {
  try {
    if (localStorage.getItem(`${BUCKET_SCOPE_PREFIX}${id}`) === "active") return "active";
  } catch {
    /* ignore */
  }
  return "all";
}

function writeBucketScope(id: string, scope: "all" | "active"): void {
  try {
    localStorage.setItem(`${BUCKET_SCOPE_PREFIX}${id}`, scope);
  } catch {
    /* ignore */
  }
}

function persistSort(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function effectiveDueMs(item: Item): number {
  let min =
    item.status === "open" && item.due_at ? new Date(item.due_at).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isNaN(min)) min = Number.POSITIVE_INFINITY;
  for (const child of item.subtasks ?? []) {
    min = Math.min(min, effectiveDueMs(child));
  }
  return min;
}

function collectFoldableIds(items: Item[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if ((item.subtasks ?? []).length) {
      ids.push(item.id);
      ids.push(...collectFoldableIds(item.subtasks ?? []));
    }
  }
  return ids;
}

function ancestorIds(items: Item[], targetId: string, trail: string[] = []): string[] | null {
  for (const item of items) {
    if (item.id === targetId) return trail;
    const found = ancestorIds(item.subtasks ?? [], targetId, [...trail, item.id]);
    if (found) return found;
  }
  return null;
}

function itemNotifyUrl(item: Item, buckets: Bucket[]): string {
  const bucket = buckets.find((b) => b.id === item.bucket_id);
  const path = !bucket || bucket.is_inbox ? "/" : `/b/${item.bucket_id}`;
  return `${path}?item=${encodeURIComponent(item.id)}`;
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
): { recur_interval: number | null; recur_unit: RecurUnit | null } {
  if (!preset) return { recur_interval: null, recur_unit: null };
  if (preset === "daily") return { recur_interval: 1, recur_unit: "day" };
  if (preset === "weekly") return { recur_interval: 1, recur_unit: "week" };
  if (preset === "monthly") return { recur_interval: 1, recur_unit: "month" };
  if (preset === "yearly") return { recur_interval: 1, recur_unit: "year" };
  return { recur_interval: Math.max(1, Number(n) || 1), recur_unit: unit };
}

function addMonthsLocal(d: Date, months: number): Date {
  const copy = new Date(d.getTime());
  const day = copy.getDate();
  copy.setDate(1);
  copy.setMonth(copy.getMonth() + months);
  const last = new Date(copy.getFullYear(), copy.getMonth() + 1, 0).getDate();
  copy.setDate(Math.min(day, last));
  return copy;
}

function advanceDueIso(iso: string, interval: number, unit: RecurUnit): string {
  const d = new Date(iso);
  if (unit === "day") d.setDate(d.getDate() + interval);
  else if (unit === "week") d.setDate(d.getDate() + interval * 7);
  else if (unit === "month") return addMonthsLocal(d, interval).toISOString();
  else return addMonthsLocal(d, interval * 12).toISOString();
  return d.toISOString();
}

function insertNewline(
  el: HTMLTextAreaElement,
  value: string,
  setValue: (next: string) => void,
): void {
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

function createdMs(iso: string, invalid: number): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? invalid : t;
}

function hexHue(hex: string): number {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return 0;
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function sortAllItems(items: Item[], buckets: Bucket[], sort: AllSort): Item[] {
  const byId = new Map(buckets.map((b) => [b.id, b]));
  const copy = [...items];
  copy.sort((a, b) => {
    const ba = byId.get(a.bucket_id);
    const bb = byId.get(b.bucket_id);
    if (sort === "created-new" || sort === "created-old") {
      const invalid = sort === "created-new" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      const ca = createdMs(a.created_at, invalid);
      const cb = createdMs(b.created_at, invalid);
      if (ca !== cb) return sort === "created-new" ? cb - ca : ca - cb;
      return (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" });
    }
    if (sort === "due") {
      const da = effectiveDueMs(a);
      const db = effectiveDueMs(b);
      if (da !== db) return da - db;
      return (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" });
    }
    if (sort === "bucket") {
      return (ba?.name ?? "").localeCompare(bb?.name ?? "", undefined, { sensitivity: "base" });
    }
    const ha = hexHue(ba?.color ?? "");
    const hb = hexHue(bb?.color ?? "");
    if (ha !== hb) return ha - hb;
    return (ba?.name ?? "").localeCompare(bb?.name ?? "", undefined, { sensitivity: "base" });
  });
  return copy;
}

function reminderStorageKey(itemId: string, remindAt: number): string {
  return `magictodo:reminder:${itemId}:${remindAt}`;
}

function fireReminder(item: Item, body: string, remindAt: number, url: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const key = reminderStorageKey(item.id, remindAt);
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch {
    /* private mode */
  }
  const title = item.title?.trim() || "Untitled";
  void showLocalNotification(title, body, url).catch(() => {
    /* ignore */
  });
}

function fireNudge(item: Item, remindAt: number, url: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const key = `magictodo:nudge:${item.id}:${remindAt}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch {
    /* private mode */
  }
  const title = item.title?.trim() || "Untitled";
  void showLocalNotification(title, "Reminder", url).catch(() => {
    /* ignore */
  });
}

function fireDue(item: Item, dueAt: number, url: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (Date.now() - dueAt > 24 * 60 * 60 * 1000) return;
  const key = `magictodo:due:${item.id}:${dueAt}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch {
    /* private mode */
  }
  const title = item.title?.trim() || "Untitled";
  void showLocalNotification(title, "Due now", url).catch(() => {
    /* ignore */
  });
}

function scheduleTimer(cb: () => void, delay: number, timers: number[]): void {
  if (delay >= MAX_TIMER_DELAY) return;
  timers.push(window.setTimeout(cb, delay));
}

async function ensureNotifyPermission(): Promise<boolean> {
  try {
    return await subscribePush();
  } catch {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    return Notification.permission === "granted";
  }
}

function updateTree(items: Item[], id: string, fn: (item: Item) => Item | null): Item[] {
  const next: Item[] = [];
  for (const item of items) {
    if (item.id === id) {
      const updated = fn(item);
      if (updated) next.push(updated);
      continue;
    }
    const subtasks = updateTree(item.subtasks ?? [], id, fn);
    next.push({ ...item, subtasks });
  }
  return next;
}

function pruneHidden(items: Item[], includeDone: boolean): Item[] {
  if (includeDone) return items;
  const next: Item[] = [];
  for (const item of items) {
    const kids = pruneHidden(item.subtasks ?? [], includeDone);
    if (item.status === "open") {
      next.push({ ...item, subtasks: kids });
    } else if (kids.length) {
      next.push({ ...item, subtasks: kids });
    }
  }
  return next;
}

function itemMatchesQuery(item: Item, needle: string): boolean {
  const hay = `${item.title || ""} ${item.notes || ""} ${item.ocr_text || ""}`.toLowerCase();
  return hay.includes(needle);
}

function filterSearch(items: Item[], query: string): Item[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  const next: Item[] = [];
  for (const item of items) {
    if (itemMatchesQuery(item, needle)) {
      next.push(item);
      continue;
    }
    const kids = filterSearch(item.subtasks ?? [], query);
    if (kids.length) next.push({ ...item, subtasks: kids });
  }
  return next;
}

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.(TEXT_DRAG_SEL));
}

function isCoarsePointer(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

function findItem(items: Item[], id: string): Item | null {
  for (const it of items) {
    if (it.id === id) return it;
    const nested = findItem(it.subtasks ?? [], id);
    if (nested) return nested;
  }
  return null;
}

function findParent(items: Item[], id: string): Item | null {
  for (const it of items) {
    if ((it.subtasks ?? []).some((child) => child.id === id)) return it;
    const nested = findParent(it.subtasks ?? [], id);
    if (nested) return nested;
  }
  return null;
}

function siblingIds(items: Item[], item: Item): string[] {
  if (item.parent_id) {
    const parent = findItem(items, item.parent_id) ?? findParent(items, item.id);
    return (parent?.subtasks ?? []).map((s) => s.id);
  }
  return items.map((p) => p.id);
}

function insertBefore(ids: string[], dragged: string, before: string): string[] {
  const next = ids.filter((id) => id !== dragged);
  const idx = next.indexOf(before);
  if (idx === -1) return ids;
  next.splice(idx, 0, dragged);
  return next;
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

function startOfLocalDay(d = new Date()): Date {
  const next = new Date(d);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addLocalDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDayParam(raw: string | null): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  if (!year || !month || !day) return null;
  const next = new Date(year, month - 1, day);
  next.setHours(0, 0, 0, 0);
  if (next.getFullYear() !== year || next.getMonth() !== month - 1 || next.getDate() !== day) return null;
  return next;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDoneDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}


function transferHasFiles(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes("Files");
}

export default function Board() {
  const { bucketId } = useParams();
  const location = useLocation();
  const showDepartmentWork = useDepartmentWorkNav();
  const navigate = useNavigate();
  const viewAll = location.pathname === "/all";
  const viewDone = location.pathname === "/done";
  const todayKey = dayKey(startOfLocalDay());
  const doneDay = useMemo(() => {
    const today = parseDayParam(todayKey) ?? startOfLocalDay();
    if (!viewDone) return today;
    const parsed = parseDayParam(new URLSearchParams(location.search).get("day"));
    if (!parsed || parsed.getTime() > today.getTime()) return today;
    return parsed;
  }, [viewDone, location.search, todayKey]);
  const doneIsToday = dayKey(doneDay) === todayKey;
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [includeDone, setIncludeDone] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileOver, setFileOver] = useState(false);
  const fileOverCount = useRef(0);
  const [busy, setBusy] = useState(false);
  const [addingBucket, setAddingBucket] = useState(false);
  const [addingParentId, setAddingParentId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLOR_PALETTE[2]);
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingBucketId, setDraggingBucketId] = useState<string | null>(null);
  const [dropBucketId, setDropBucketId] = useState<string | null>(null);
  const [dropBucketReorderId, setDropBucketReorderId] = useState<string | null>(null);
  const [dropItemId, setDropItemId] = useState<string | null>(null);
  const [dropFileItemId, setDropFileItemId] = useState<string | null>(null);
  const [dragReadyId, setDragReadyId] = useState<string | null>(null);
  const [bucketDragReadyId, setBucketDragReadyId] = useState<string | null>(null);
  const bucketDragMoved = useRef(false);
  const draggingBucketIdRef = useRef<string | null>(null);
  const [colorMenu, setColorMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const renamingIdRef = useRef<string | null>(null);
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
  const [allSort, setAllSort] = useState<AllSort>(readAllSort);
  const [bucketSort, setBucketSort] = useState<BucketSort>(readBucketSort);
  const [doneBucket, setDoneBucket] = useState(readDoneBucket);
  const [compact, setCompact] = useState(readInboxCompact);
  const [compactShowNotes, setCompactShowNotes] = useState(readInboxCompactNotes);
  const [folded, setFolded] = useState<Set<string>>(readFolded);
  const [bucketFolded, setBucketFolded] = useState<Set<string>>(readBucketFolded);
  const [bucketScope, setBucketScope] = useState<"all" | "active">("all");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [useClientReminders, setUseClientReminders] = useState(true);
  const [itemRemindersOn, setItemRemindersOn] = useState(true);
  const [remarkableConfigured, setRemarkableConfigured] = useState(false);

  const inbox = buckets.find((b) => b.is_inbox);
  const current = viewAll || viewDone ? inbox : bucketId ? buckets.find((b) => b.id === bucketId) : inbox;
  const menuBucket = colorMenu ? buckets.find((b) => b.id === colorMenu.id) : undefined;
  const viewBucketId = viewAll || viewDone ? undefined : current?.id;
  const currentHasChildren = Boolean(current && buckets.some((b) => b.parent_id === current.id));
  const includeDescendants = Boolean(currentHasChildren && bucketScope === "all");
  const doneBucketFilter =
    doneBucket && buckets.some((b) => b.id === doneBucket) ? doneBucket : "";
  const allOpenCount = buckets.filter((b) => !b.parent_id).reduce((sum, b) => sum + b.open_count, 0);
  const sidebarBuckets = useMemo(() => walkBucketTree(buckets, { folded: bucketFolded }), [buckets, bucketFolded]);
  const visibleItems = useMemo(() => {
    let next: Item[];
    if (viewDone) {
      if (!doneBucketFilter) next = items;
      else {
        const ids = new Set([doneBucketFilter, ...bucketDescendantIds(buckets, doneBucketFilter)]);
        next = items.filter((item) => ids.has(item.bucket_id));
      }
    } else if (viewAll) next = sortAllItems(items, buckets, allSort);
    else if (bucketSort === "manual") next = items;
    else next = sortAllItems(items, buckets, bucketSort);
    return filterSearch(next, search);
  }, [viewAll, viewDone, items, buckets, allSort, bucketSort, doneBucketFilter, search]);
  const foldableIds = useMemo(() => collectFoldableIds(visibleItems), [visibleItems]);
  const allFolded = foldableIds.length > 0 && foldableIds.every((id) => folded.has(id));

  async function loadBuckets() {
    setBuckets(await api.buckets());
  }

  async function loadItems(id: string | undefined, done: boolean) {
    if (viewDone) {
      const from = startOfLocalDay(doneDay);
      const to = addLocalDays(from, 1);
      setItems(await api.items(undefined, true, from.toISOString(), to.toISOString()));
      return;
    }
    if (!viewAll && !id) return;
    setItems(await api.items(id, done, undefined, undefined, Boolean(id && includeDescendants)));
  }

  function setDoneDay(next: Date) {
    const today = parseDayParam(todayKey) ?? startOfLocalDay();
    const day = startOfLocalDay(next);
    const clamped = day.getTime() > today.getTime() ? today : day;
    const params = new URLSearchParams(location.search);
    if (isSameLocalDay(clamped, today)) params.delete("day");
    else params.set("day", dayKey(clamped));
    const qs = params.toString();
    navigate(`/done${qs ? `?${qs}` : ""}`);
  }

  useEffect(() => {
    void loadBuckets().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : "Failed to load buckets"),
    );
    void api
      .remarkableStatus()
      .then((status) => setRemarkableConfigured(Boolean(status.configured)))
      .catch(() => setRemarkableConfigured(false));
  }, []);

  useEffect(() => {
    function syncInboxPrefs() {
      setCompact(readInboxCompact());
      setCompactShowNotes(readInboxCompactNotes());
    }
    window.addEventListener("storage", syncInboxPrefs);
    return () => window.removeEventListener("storage", syncInboxPrefs);
  }, []);

  useEffect(() => {
    if (viewDone) {
      void loadItems(undefined, true).catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load items"),
      );
      return;
    }
    if (viewAll) {
      void loadItems(undefined, includeDone).catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load items"),
      );
      return;
    }
    if (!current) return;
    void loadItems(current.id, includeDone).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : "Failed to load items"),
    );
  }, [viewAll, viewDone, current?.id, includeDone, doneDay, includeDescendants]);

  useEffect(() => {
    if (!current?.id) return;
    setBucketScope(readBucketScope(current.id));
  }, [current?.id]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get("item");
    if (!id || items.length === 0) return;
    const found = findItem(items, id);
    if (!found) return;
    const ancestors = ancestorIds(items, id) ?? [];
    if (ancestors.length) {
      setFolded((prev) => {
        const next = new Set(prev);
        for (const a of ancestors) next.delete(a);
        writeFolded(next);
        return next;
      });
    }
    setFocusId(id);
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`item-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    navigate({ pathname: location.pathname, search: "" }, { replace: true });
    const timer = window.setTimeout(() => setFocusId(null), 1800);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [items, location.pathname, location.search, navigate]);

  const previewItems = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );
  useEffect(() => {
    return () => {
      for (const row of previewItems) URL.revokeObjectURL(row.url);
    };
  }, [previewItems]);

  useEffect(() => {
    if (!colorMenu) return;
    function close() {
      setColorMenu(null);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    const timer = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [colorMenu]);

  useEffect(() => {
    void hasPushSubscription()
      .then((on) => setUseClientReminders(!on))
      .catch(() => setUseClientReminders(true));
    void api
      .notificationPreferences()
      .then((prefs) => setItemRemindersOn(prefs.global.item_reminder !== false))
      .catch(() => setItemRemindersOn(true));
  }, []);

  useEffect(() => {
    if (!useClientReminders || !itemRemindersOn) return;
    const timers: number[] = [];
    const now = Date.now();
    for (const item of flattenItems(items)) {
      if (item.status !== "open") continue;
      if (item.due_at) {
        const due = new Date(item.due_at).getTime();
        if (!Number.isNaN(due)) {
          if (item.reminder_lead_minutes && due > now) {
            const remindAt = due - item.reminder_lead_minutes * 60_000;
            const lead = REMINDER_LEADS.find((row) => row.minutes === item.reminder_lead_minutes);
            const upcomingBody = lead?.body ?? "Due soon";
            if (remindAt <= now) {
              fireReminder(item, "Due soon", remindAt, itemNotifyUrl(item, buckets));
            } else {
              scheduleTimer(
                () => fireReminder(item, upcomingBody, remindAt, itemNotifyUrl(item, buckets)),
                remindAt - now,
                timers,
              );
            }
          }
          if (due <= now) {
            fireDue(item, due, itemNotifyUrl(item, buckets));
          } else {
            scheduleTimer(() => fireDue(item, due, itemNotifyUrl(item, buckets)), due - now, timers);
          }
        }
      }
      if (item.remind_at) {
        const at = new Date(item.remind_at).getTime();
        if (Number.isNaN(at)) continue;
        if (at <= now) {
          fireNudge(item, at, itemNotifyUrl(item, buckets));
        } else {
          scheduleTimer(() => fireNudge(item, at, itemNotifyUrl(item, buckets)), at - now, timers);
        }
      }
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [items, buckets, useClientReminders, itemRemindersOn]);

  async function refreshAll() {
    await loadBuckets();
    await loadItems(viewBucketId, includeDone);
  }

  useLiveReload((event) => event.channel === "inbox", () => refreshAll());

  function onComposerPaste(e: ClipboardEvent<HTMLFormElement>) {
    const incoming = filesFromDataTransfer(e.clipboardData);
    if (!incoming.length) return;
    e.preventDefault();
    setFiles((prev) => [...prev, ...incoming]);
  }

  function onComposerDragEnter(e: DragEvent<HTMLFormElement>) {
    if (!transferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    fileOverCount.current += 1;
    setFileOver(true);
  }

  function onComposerDragOver(e: DragEvent<HTMLFormElement>) {
    if (!transferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onComposerDragLeave() {
    fileOverCount.current = Math.max(0, fileOverCount.current - 1);
    if (fileOverCount.current === 0) setFileOver(false);
  }

  function onComposerDrop(e: DragEvent<HTMLFormElement>) {
    if (!transferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    fileOverCount.current = 0;
    setFileOver(false);
    const incoming = filesFromDataTransfer(e.dataTransfer);
    if (incoming.length) setFiles((prev) => [...prev, ...incoming]);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() && files.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      const dumped = splitDump(text);
      if (dumped.title) form.append("title", dumped.title);
      if (dumped.notes) form.append("notes", dumped.notes);
      form.append("source", "web");
      if (current) form.append("bucket_id", current.id);
      for (const file of files) form.append("files", file);
      await api.createItem(form);
      setText("");
      setFiles([]);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add item");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: Item) {
    const interval = item.recur_interval;
    const unit = item.recur_unit;
    const due = item.due_at;
    if (item.status === "open" && interval && unit && due) {
      const nextDue = advanceDueIso(due, interval, unit);
      setItems((prev) =>
        updateTree(prev, item.id, (it) => ({ ...it, due_at: nextDue, remind_at: null })),
      );
      try {
        await api.patchItem(item.id, { status: "done" });
        await loadBuckets();
        await loadItems(viewBucketId, includeDone);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update");
        await loadItems(viewBucketId, includeDone);
      }
      return;
    }
    const next: Item["status"] = item.status === "open" ? "done" : "open";
    setItems((prev) =>
      pruneHidden(
        updateTree(prev, item.id, (it) => ({ ...it, status: next })),
        includeDone,
      ),
    );
    try {
      await api.patchItem(item.id, { status: next });
      await loadBuckets();
      await loadItems(viewBucketId, includeDone);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update");
      await loadItems(viewBucketId, includeDone);
    }
  }

  async function move(item: Item, dest: string) {
    if (item.plan_task_id || dest === item.bucket_id) return;
    await api.patchItem(item.id, { bucket_id: dest });
    await refreshAll();
  }

  async function reparent(item: Item, parentId: string | null) {
    if (parentId === item.parent_id) return;
    if (parentId === item.id) return;
    await api.patchItem(item.id, { parent_id: parentId });
    await refreshAll();
  }

  function toggleFold(item: Item) {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      writeFolded(next);
      return next;
    });
  }

  function foldAllSteps() {
    const next = new Set(foldableIds);
    setFolded(next);
    writeFolded(next);
  }

  function unfoldAllSteps() {
    setFolded(new Set());
    writeFolded(new Set());
  }

  async function later(item: Item, minutes: number | null) {
    const remind_at =
      minutes == null ? null : new Date(Date.now() + minutes * 60_000).toISOString();
    await api.patchItem(item.id, { remind_at });
    if (minutes) {
      const on = await ensureNotifyPermission();
      if (on) setUseClientReminders(false);
    }
    await refreshAll();
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
    await refreshAll();
  }

  async function sendToRemarkable(item: Item) {
    setError("");
    try {
      await api.sendToRemarkable(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send to reMarkable");
    }
  }

  async function createBucket(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const parentId = addingParentId;
    const bucket = await api.createBucket(newName.trim(), newColor, parentId);
    setNewName("");
    setAddingBucket(false);
    setAddingParentId(null);
    if (parentId) {
      setBucketFolded((prev) => {
        const next = new Set(prev);
        next.delete(parentId);
        writeBucketFolded(next);
        return next;
      });
    }
    await loadBuckets();
    navigate(`/b/${bucket.id}`);
    setMenuOpen(false);
  }

  function startAddSubBucket(id: string) {
    setColorMenu(null);
    setAddingParentId(id);
    setAddingBucket(true);
    setMenuOpen(true);
  }

  function toggleBucketFold(id: string) {
    setBucketFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeBucketFolded(next);
      return next;
    });
  }

  async function moveBucketToRoot(id: string) {
    setColorMenu(null);
    try {
      await api.updateBucket(id, { parent_id: null });
      await loadBuckets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move bucket");
    }
  }

  async function setBucketColor(id: string, color: string, close = true) {
    await api.updateBucket(id, { color });
    if (close) setColorMenu(null);
    await loadBuckets();
  }

  function startRename(id: string) {
    const bucket = buckets.find((b) => b.id === id);
    if (!bucket || bucket.is_inbox || bucket.locked) return;
    setColorMenu(null);
    renamingIdRef.current = bucket.id;
    setRenamingId(bucket.id);
    setRenameName(bucket.name);
  }

  function cancelRename() {
    renamingIdRef.current = null;
    setRenamingId(null);
  }

  async function commitRename() {
    const id = renamingIdRef.current;
    if (!id) return;
    const bucket = buckets.find((b) => b.id === id);
    const name = renameName.trim();
    renamingIdRef.current = null;
    setRenamingId(null);
    if (!bucket || bucket.is_inbox || bucket.locked || !name || name === bucket.name) return;
    try {
      await api.updateBucket(id, { name });
      await loadBuckets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename bucket");
    }
  }

  function onDragStart(e: DragEvent, item: Item) {
    if (isTextTarget(e.target) || (window.getSelection()?.toString() ?? "").length > 0) {
      e.preventDefault();
      setDragReadyId(null);
      return;
    }
    e.dataTransfer.setData("text/plain", item.id);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(item.id);
  }

  function onCardMouseDown(e: MouseEvent, item: Item) {
    if (editingId === item.id || isTextTarget(e.target)) {
      setDragReadyId(null);
      return;
    }
    setDragReadyId(item.id);
  }

  function onCardDragOver(e: DragEvent, item: Item) {
    if (transferHasFiles(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropFileItemId(item.id);
      return;
    }
    if (viewAll || viewDone || bucketSort !== "manual") return;
    if (!draggingId || draggingId === item.id) return;
    const dragged = findItem(items, draggingId);
    if (!dragged) return;
    const sameList =
      dragged.parent_id === item.parent_id && dragged.bucket_id === item.bucket_id;
    if (!sameList) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropItemId(item.id);
    setDropBucketId(null);
  }

  function onCardDragLeave(e: DragEvent, item: Item) {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDropFileItemId((id) => (id === item.id ? null : id));
  }

  async function onCardDrop(e: DragEvent, item: Item) {
    if (transferHasFiles(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      setDropFileItemId(null);
      const incoming = filesFromDataTransfer(e.dataTransfer);
      if (incoming.length) await attachFiles(item, incoming);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("text/plain") || draggingId;
    setDropItemId(null);
    setDraggingId(null);
    setDragReadyId(null);
    if (viewAll || viewDone || bucketSort !== "manual") return;
    if (!id || id === item.id) return;
    const dragged = findItem(items, id);
    if (!dragged) return;
    if (dragged.parent_id !== item.parent_id || dragged.bucket_id !== item.bucket_id) return;
    const next = insertBefore(siblingIds(items, item), id, item.id);
    if (next.join() === siblingIds(items, item).join()) return;
    await api.reorderItems(next);
    await refreshAll();
  }

  function onBucketMouseDown(bucket: Bucket) {
    setBucketDragReadyId(bucket.id);
  }

  function onBucketDragStart(e: DragEvent, bucket: Bucket) {
    e.dataTransfer.setData(BUCKET_DRAG_MIME, bucket.id);
    e.dataTransfer.setData("text/plain", bucket.id);
    e.dataTransfer.effectAllowed = "move";
    bucketDragMoved.current = true;
    draggingBucketIdRef.current = bucket.id;
    setDraggingBucketId(bucket.id);
    setDropBucketId(null);
  }

  function onBucketDragEnd() {
    draggingBucketIdRef.current = null;
    setDraggingBucketId(null);
    setBucketDragReadyId(null);
    setDropBucketReorderId(null);
    window.setTimeout(() => {
      bucketDragMoved.current = false;
    }, 0);
  }

  function onBucketDragOver(e: DragEvent, bucket: Bucket) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const dragging = draggingBucketIdRef.current;
    if (dragging) {
      const dragged = buckets.find((b) => b.id === dragging);
      const sameParent = Boolean(dragged) && (dragged?.parent_id || null) === (bucket.parent_id || null);
      if (sameParent) {
        setDropBucketId(null);
        setDropBucketReorderId(dragging === bucket.id ? null : bucket.id);
      } else {
        setDropBucketReorderId(null);
        setDropBucketId(dragging === bucket.id ? null : bucket.id);
      }
      return;
    }
    setDropBucketReorderId(null);
    setDropBucketId(bucket.id);
  }

  async function onBucketDrop(e: DragEvent, bucket: Bucket) {
    e.preventDefault();
    e.stopPropagation();
    const draggedBucketId =
      e.dataTransfer.getData(BUCKET_DRAG_MIME) || draggingBucketIdRef.current;
    setDropBucketId(null);
    setDropBucketReorderId(null);
    if (draggedBucketId) {
      draggingBucketIdRef.current = null;
      setDraggingBucketId(null);
      setBucketDragReadyId(null);
      const dragged = buckets.find((b) => b.id === draggedBucketId);
      if (!dragged || dragged.id === bucket.id) return;
      if (dragged.locked || dragged.is_inbox) return;
      const sameParent = (dragged.parent_id || null) === (bucket.parent_id || null);
      if (sameParent) {
        const siblings = bucketChildren(buckets, dragged.parent_id || null).map((b) => b.id);
        const next = insertBefore(siblings, draggedBucketId, bucket.id);
        if (next.join() === siblings.join()) return;
        try {
          await api.reorderBuckets(next);
          await loadBuckets();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not reorder buckets");
          await loadBuckets();
        }
        return;
      }
      const nestedUnderDrag = bucketDescendantIds(buckets, dragged.id);
      if (nestedUnderDrag.has(bucket.id)) return;
      try {
        await api.updateBucket(dragged.id, { parent_id: bucket.id });
        await loadBuckets();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not move bucket");
      }
      return;
    }
    const id = e.dataTransfer.getData("text/plain") || draggingId;
    setDraggingId(null);
    if (!id) return;
    const item = findItem(items, id);
    if (!item || item.plan_task_id || item.parent_id || item.bucket_id === bucket.id) return;
    await move(item, bucket.id);
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
    const recur = dueAt ? recurPayload(editRecur, editRecurN, editRecurUnit) : { recur_interval: null, recur_unit: null };
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
      if (dueAt) {
        const on = await ensureNotifyPermission();
        if (on) setUseClientReminders(false);
      }
      setEditingId(null);
      await refreshAll();
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
    composerEnterKey(
      e,
      isNotes ? editNotes : editTitle,
      isNotes ? setEditNotes : setEditTitle,
      () => void saveEdit(),
    );
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
    await refreshAll();
  }

  async function attachFiles(item: Item, incoming: File[]) {
    if (!incoming.length) return;
    setError("");
    try {
      for (const file of incoming) {
        await api.addAttachment(item.id, file);
      }
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach file");
      await refreshAll();
    }
  }

  async function detachFile(item: Item, attachmentId: string) {
    setError("");
    try {
      await api.deleteAttachment(item.id, attachmentId);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove file");
    }
  }

  const cardProps = {
    items,
    buckets,
    allView: viewAll || viewDone,
    allowReorder: !viewAll && !viewDone && bucketSort === "manual",
    draggingId,
    dropItemId,
    dropFileItemId,
    dragReadyId,
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
    onReparent: (item: Item, parentId: string | null) => void reparent(item, parentId),
    onRemove: (item: Item) => void remove(item),
    onToggleFold: toggleFold,
    onDragStart,
    onDragEnd: () => {
      setDraggingId(null);
      setDropBucketId(null);
      setDropItemId(null);
      setDropFileItemId(null);
      setDragReadyId(null);
    },
    onCardMouseDown,
    onCardDragOver,
    onCardDragLeave,
    onCardDrop,
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
        writeFolded(next);
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
    compact,
    compactShowNotes,
  };

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
        <Link
          className={`bucket-link${viewAll ? " active" : ""}`}
          to="/all"
          onClick={() => setMenuOpen(false)}
        >
          All
          <span className="count">{allOpenCount}</span>
        </Link>
        <Link
          className={`bucket-link${viewDone ? " active" : ""}`}
          to="/done"
          onClick={() => setMenuOpen(false)}
        >
          Done today
        </Link>
        <Link className="bucket-link" to="/calendar" onClick={() => setMenuOpen(false)}>
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
        {sidebarBuckets.map(({ bucket: b, depth, hasChildren }) =>
          renamingId === b.id ? (
            <form
              key={b.id}
              className={`bucket-link bucket-rename${!viewAll && !viewDone && current?.id === b.id ? " active" : ""}`}
              style={{ ["--depth" as string]: depth }}
              onSubmit={(e) => {
                e.preventDefault();
                void commitRename();
              }}
            >
              <span className="bucket-indent" />
              <span className="dot" style={{ background: b.color }} />
              <input
                autoFocus
                maxLength={80}
                value={renameName}
                aria-label="Rename bucket"
                onChange={(e) => setRenameName(e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={() => void commitRename()}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
              />
              <span className="count">{b.open_count}</span>
            </form>
          ) : (
            <Link
              key={b.id}
              className={`bucket-link${!viewAll && !viewDone && current?.id === b.id ? " active" : ""}${dropBucketId === b.id ? " drag-over" : ""}${draggingBucketId === b.id ? " dragging" : ""}${dropBucketReorderId === b.id ? " drop-before" : ""}`}
              style={{ ["--depth" as string]: depth }}
              to={b.is_inbox ? "/" : `/b/${b.id}`}
              draggable={bucketDragReadyId === b.id && !b.locked && !b.is_inbox}
              onMouseDown={() => onBucketMouseDown(b)}
              onDragStart={(e) => onBucketDragStart(e, b)}
              onDragEnd={onBucketDragEnd}
              onClick={(e) => {
                if (bucketDragMoved.current) {
                  e.preventDefault();
                  bucketDragMoved.current = false;
                  return;
                }
                setMenuOpen(false);
              }}
              onDragOver={(e) => {
                setDropItemId(null);
                onBucketDragOver(e, b);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                cancelRename();
                setColorMenu({ id: b.id, x: e.clientX, y: e.clientY });
              }}
              onDragLeave={(e) => {
                const next = e.relatedTarget as Node | null;
                if (next && e.currentTarget.contains(next)) return;
                setDropBucketId((id) => (id === b.id ? null : id));
                setDropBucketReorderId((id) => (id === b.id ? null : id));
              }}
              onDrop={(e) => void onBucketDrop(e, b)}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="bucket-twist"
                  aria-label={bucketFolded.has(b.id) ? "Expand" : "Collapse"}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleBucketFold(b.id);
                  }}
                >
                  {bucketFolded.has(b.id) ? "▸" : "▾"}
                </button>
              ) : (
                <span className="bucket-twist spacer" />
              )}
              <span className="dot" style={{ background: b.color }} />
              {b.name}
              <span className="count">{b.open_count}</span>
            </Link>
          ),
        )}
        {addingBucket ? (
          <form className="new-bucket" onSubmit={(e) => void createBucket(e)}>
            <input
              autoFocus
              placeholder={addingParentId ? "Sub-bucket name" : "Bucket name"}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <ColorPicker value={newColor} onChange={setNewColor} />
            <div className="composer-row">
              <button className="btn small" type="submit">
                Add
              </button>
              <button
                className="btn ghost small"
                type="button"
                onClick={() => {
                  setAddingBucket(false);
                  setAddingParentId(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            className="nav-btn"
            onClick={() => {
              setAddingParentId(null);
              setAddingBucket(true);
            }}
          >
            + New bucket
          </button>
        )}
        <div className="sidebar-foot">
          <Link className="nav-btn" to="/settings" onClick={() => setMenuOpen(false)}>
            Settings
          </Link>
        </div>
        <SidebarResizeHandle />
        <InboxResizeHandle />
      </aside>

      <main className="main inbox">
        <div className="main-head">
          <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open buckets">
            Buckets
          </button>
          <h1>
            {viewDone ? (doneIsToday ? "Done today" : `Done ${formatDoneDay(doneDay)}`) : viewAll ? "All" : (current?.name ?? "Inbox")}
          </h1>
          <input
            className="item-search"
            type="search"
            value={search}
            placeholder="Search todos…"
            aria-label="Search todos on this page"
            onChange={(e) => setSearch(e.target.value)}
          />
          {!viewAll && !viewDone && currentHasChildren ? (
            <label className="toggle">
              Show
              <select
                className="sort-select"
                value={bucketScope}
                aria-label="Show all or this level"
                onChange={(e) => {
                  const next = e.target.value === "active" ? "active" : "all";
                  setBucketScope(next);
                  if (current?.id) writeBucketScope(current.id, next);
                }}
              >
                <option value="all">All</option>
                <option value="active">Active level</option>
              </select>
            </label>
          ) : null}
          {viewDone ? (
            <>
              <div className="done-nav">
                {doneIsToday ? null : (
                  <button className="btn ghost small" type="button" onClick={() => setDoneDay(parseDayParam(todayKey) ?? startOfLocalDay())}>
                    Today
                  </button>
                )}
                <button
                  className="btn ghost small"
                  type="button"
                  aria-label="Previous day"
                  onClick={() => setDoneDay(addLocalDays(doneDay, -1))}
                >
                  ‹
                </button>
                <input
                  type="date"
                  className="sort-select"
                  value={dayKey(doneDay)}
                  max={todayKey}
                  aria-label="Done on day"
                  onChange={(e) => {
                    const parsed = parseDayParam(e.target.value);
                    if (parsed) setDoneDay(parsed);
                  }}
                />
                <button
                  className="btn ghost small"
                  type="button"
                  aria-label="Next day"
                  disabled={doneIsToday}
                  onClick={() => setDoneDay(addLocalDays(doneDay, 1))}
                >
                  ›
                </button>
              </div>
              <label className="toggle">
                Bucket
                <select
                  className="sort-select"
                  value={doneBucketFilter}
                  aria-label="Filter done items by bucket"
                  onChange={(e) => {
                    const next = e.target.value;
                    setDoneBucket(next);
                    persistSort(DONE_BUCKET_KEY, next);
                  }}
                >
                  <option value="">All buckets</option>
                  {walkBucketTree(buckets).map(({ bucket: b, depth }) => (
                    <option key={b.id} value={b.id}>
                      {bucketOptionLabel(b, depth)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {viewAll ? (
            <label className="toggle">
              Sort
              <select
                className="sort-select"
                value={allSort}
                aria-label="Sort all items"
                onChange={(e) => {
                  const next = e.target.value as AllSort;
                  setAllSort(next);
                  persistSort(ALL_SORT_KEY, next);
                }}
              >
                <option value="due">Due date</option>
                <option value="created-new">Created, from Newest to Oldest</option>
                <option value="created-old">Created, from Oldest to Newest</option>
                <option value="bucket">Bucket name</option>
                <option value="color">Color</option>
              </select>
            </label>
          ) : null}
          {viewDone ? null : viewAll ? null : (
            <label className="toggle">
              Sort
              <select
                className="sort-select"
                value={bucketSort}
                aria-label="Sort items"
                onChange={(e) => {
                  const next = e.target.value as BucketSort;
                  setBucketSort(next);
                  persistSort(BUCKET_SORT_KEY, next);
                }}
              >
                <option value="manual">Manual</option>
                <option value="due">Due date</option>
                <option value="created-new">Created, from Newest to Oldest</option>
                <option value="created-old">Created, from Oldest to Newest</option>
              </select>
            </label>
          )}
          {viewDone || foldableIds.length === 0 ? null : (
            <button
              type="button"
              className="btn ghost small"
              onClick={() => (allFolded ? unfoldAllSteps() : foldAllSteps())}
            >
              {allFolded ? "Unfold all steps" : "Fold all steps"}
            </button>
          )}
          {viewDone ? null : (
            <label className="toggle">
              <input
                type="checkbox"
                checked={includeDone}
                onChange={(e) => setIncludeDone(e.target.checked)}
              />
              Show done
            </label>
          )}
        </div>

        {error ? <p className="error">{error}</p> : null}

        {viewDone ? null : (
        <form
          className={`composer${fileOver ? " file-over" : ""}`}
          onSubmit={(e) => void onCreate(e)}
          onPaste={onComposerPaste}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          <textarea
            placeholder={
              viewAll || current?.is_inbox
                ? "Dump it here…"
                : `Add to ${current?.name ?? "this bucket"}…`
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              composerEnterKey(e, text, setText, () => e.currentTarget.form?.requestSubmit());
            }}
          />
          {previewItems.length ? (
            <div className="preview">
              {previewItems.map((row) => (
                <div className="preview-item" key={row.url}>
                  {row.file.type.startsWith("image/") ? (
                    <img src={row.url} alt={row.file.name} />
                  ) : (
                    <span className="file-chip">{row.file.name || "File"}</span>
                  )}
                  <button
                    className="btn ghost small"
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((f) => f !== row.file))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="composer-row">
            <label className="btn ghost small file-btn">
              Camera
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  if (chosen) setFiles((prev) => [...prev, chosen]);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="btn ghost small file-btn">
              Attach
              <input
                type="file"
                multiple
                accept={FILE_ACCEPT}
                onChange={(e) => {
                  const chosen = e.target.files;
                  if (chosen?.length) setFiles((prev) => [...prev, ...Array.from(chosen)]);
                  e.target.value = "";
                }}
              />
            </label>
            <button className="btn small" type="submit" disabled={busy || (!text.trim() && files.length === 0)}>
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
        )}

        {visibleItems.length === 0 ? (
          <p className="empty">
            {search.trim()
              ? `No todos matching “${search.trim()}”.`
              : viewDone
              ? doneBucketFilter
                ? doneIsToday
                  ? "Nothing marked off today in this bucket."
                  : `Nothing marked off on ${formatDoneDay(doneDay)} in this bucket.`
                : doneIsToday
                  ? "Nothing marked off today."
                  : `Nothing marked off on ${formatDoneDay(doneDay)}.`
              : "Nothing here yet. Capture text or a file."}
          </p>
        ) : (
          <div className={`list${compact ? " compact" : ""}`}>
            {visibleItems.map((item) => (
              <TreeCards
                key={item.id}
                item={item}
                depth={0}
                viewDone={viewDone}
                folded={folded}
                focusId={focusId}
                cardProps={cardProps}
              />
            ))}
          </div>
        )}
      </main>

      {lightbox ? <LightboxOverlay lightbox={lightbox} onClose={() => setLightbox(null)} /> : null}
      {colorMenu ? (
        <div
          className="color-menu"
          style={{
            left: Math.min(colorMenu.x, window.innerWidth - 260),
            top: colorMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menuBucket?.is_inbox || menuBucket?.locked ? null : (
            <button type="button" className="menu-item" onClick={() => startRename(colorMenu.id)}>
              Rename
            </button>
          )}
          <button type="button" className="menu-item" onClick={() => startAddSubBucket(colorMenu.id)}>
            Add sub-bucket
          </button>
          {menuBucket?.parent_id && !menuBucket.locked && !menuBucket.is_inbox ? (
            <button type="button" className="menu-item" onClick={() => void moveBucketToRoot(colorMenu.id)}>
              Move to top level
            </button>
          ) : null}
          <ColorPicker
            value={menuBucket?.color || COLOR_PALETTE[0]}
            onChange={(c, source) => void setBucketColor(colorMenu.id, c, source !== "wheel")}
          />
        </div>
      ) : null}
    </div>
  );
}
