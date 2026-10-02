import { type DragEvent, type FormEvent, type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type PlanDepartment, type PlanTemplateTask } from "../api";
import OrgSidebar from "../components/OrgSidebar";
import { focusPlanTitleInput } from "../components/PlanTaskEditor";
import { ShowConnectedBanner, ShowConnectedMenuItem } from "../components/ShowConnected";
import {
  connectedChipClass,
  connectedGridClick,
  hiddenConnectedCount,
  paintedKeysFromCells,
  useConnectedOverlay,
  walkTemplateConnected,
  type ConnectedIds,
} from "../planConnected";
import { applyDepartmentSort, applyTimeBlockShift, cellInsertBeforeId, nextDeptSort, orderDepartmentIds } from "../planOrder";
import { setCountDragImage, usePlanSelection } from "../planSelect";
import {
  ZOOM_OPTIONS,
  readZoom,
  templateColOf,
  templateColumnsSpanning,
  templateDropOffset,
  templateHeading,
  templateNewOffset,
  templateUnit,
  writeZoom,
  type PlanZoom,
  type ScheduleDirection,
} from "../planZoom";

const TASK_MIME = "application/x-magictodo-template-task";
const DELIVERY_MIME = "application/x-magictodo-delivery";
const ZOOM_KEY = "magictodo:plan-zoom:template";

type DraftTask = {
  key: string;
  id?: string;
  title: string;
  notes: string;
  department_id: string;
  day_offset: number;
  notify_days_before: number | null;
  predecessor_keys: string[];
  sort_order: number;
  parent_key: string;
};

function toDraft(task: PlanTemplateTask): DraftTask {
  return {
    key: task.id,
    id: task.id,
    title: task.title,
    notes: task.notes || "",
    department_id: task.department_id || "",
    day_offset: task.day_offset ?? (task.week_offset || 0) * 7,
    notify_days_before: task.notify_days_before ?? null,
    predecessor_keys: task.parent_id ? [] : task.predecessor_ids,
    sort_order: task.sort_order,
    parent_key: task.parent_id || "",
  };
}

function parentKeysOf(task: DraftTask): Set<string> {
  const keys = new Set<string>([task.key]);
  if (task.id) keys.add(task.id);
  return keys;
}

function isChildOf(task: DraftTask, parent: DraftTask): boolean {
  return Boolean(task.parent_key) && parentKeysOf(parent).has(task.parent_key);
}

function topTasks(list: DraftTask[]): DraftTask[] {
  return list.filter((task) => !task.parent_key);
}

function childrenOf(list: DraftTask[], parent: DraftTask): DraftTask[] {
  return list
    .filter((task) => isChildOf(task, parent))
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
}

function withChildrenFollowing(list: DraftTask[]): DraftTask[] {
  const parents = new Map<string, DraftTask>();
  for (const task of list) {
    if (task.parent_key) continue;
    parents.set(task.key, task);
    if (task.id) parents.set(task.id, task);
  }
  return list.map((task) => {
    if (!task.parent_key) return task;
    const parent = parents.get(task.parent_key);
    if (!parent) return task;
    if (task.department_id === parent.department_id && task.day_offset === parent.day_offset) return task;
    return { ...task, department_id: parent.department_id, day_offset: parent.day_offset };
  });
}

function nextChildSort(list: DraftTask[], parent: DraftTask): number {
  let max = -1;
  for (const task of childrenOf(list, parent)) max = Math.max(max, task.sort_order);
  return max + 1;
}

function mergeUpdated(all: DraftTask[], updated: DraftTask[]): DraftTask[] {
  const map = new Map(updated.map((task) => [task.key, task]));
  return all.map((task) => map.get(task.key) ?? task);
}

function remapEditing(prev: DraftTask | "new" | null, nextDrafts: DraftTask[]): DraftTask | "new" | null {
  if (!prev || prev === "new") return prev;
  const byId = prev.id ? nextDrafts.find((task) => task.id === prev.id) : undefined;
  if (byId) return byId;
  const byKey = nextDrafts.find((task) => task.key === prev.key);
  if (byKey) return byKey;
  if (prev.parent_key) {
    const parent = nextDrafts.find((task) => task.id === prev.parent_key || task.key === prev.parent_key);
    const parentIds = new Set<string>([prev.parent_key]);
    if (parent) {
      parentIds.add(parent.key);
      if (parent.id) parentIds.add(parent.id);
    }
    return (
      nextDrafts.find(
        (task) => parentIds.has(task.parent_key) && task.title === prev.title && task.sort_order === prev.sort_order,
      ) ||
      nextDrafts.find((task) => parentIds.has(task.parent_key) && task.title === prev.title) ||
      prev
    );
  }
  return (
    nextDrafts.find((task) => !task.parent_key && task.title === prev.title && task.sort_order === prev.sort_order) || prev
  );
}

function parseNotifyDays(raw: string): number | null | "invalid" {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return "invalid";
  const n = Number(text);
  if (n > 365) return "invalid";
  return n;
}

function notifyDaysInput(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

export default function PlanTemplatePage() {
  const { templateId } = useParams();
  const [name, setName] = useState("");
  const [tasks, setTasks] = useState<DraftTask[]>([]);
  const [departments, setDepartments] = useState<PlanDepartment[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [direction, setDirection] = useState<ScheduleDirection>("forward");
  const [deliveryOffset, setDeliveryOffset] = useState<number | null>(null);
  const [zoom, setZoom] = useState<PlanZoom>(() => readZoom(ZOOM_KEY));
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [dropChipKey, setDropChipKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<DraftTask | "new" | null>(null);
  const [titleFocusGen, setTitleFocusGen] = useState(0);
  const [draft, setDraft] = useState({
    title: "",
    notes: "",
    department_id: "",
    day_offset: 0,
    notify_days: "",
    predecessor_keys: [] as string[],
  });
  const draggingKey = useRef<string | null>(null);
  const draggingDelivery = useRef(false);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const scrolledKey = useRef<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [pickingDeps, setPickingDeps] = useState(false);
  const pickSnapshot = useRef<string[]>([]);
  const [taskMenu, setTaskMenu] = useState<{ task: DraftTask; x: number; y: number; chain: ConnectedIds } | null>(null);
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const { connected, showConnected, hideConnected } = useConnectedOverlay(gridWrapRef);
  const unit = templateUnit(zoom);

  useLayoutEffect(() => {
    if (titleFocusGen === 0) return;
    focusPlanTitleInput(titleRef.current);
  }, [titleFocusGen]);

  async function load() {
    if (!templateId) return;
    setError("");
    try {
      const [template, overview] = await Promise.all([api.getPlanTemplate(templateId), api.planOverview()]);
      setName(template.name);
      setDirection(template.schedule_direction === "backward" ? "backward" : "forward");
      setDeliveryOffset(template.delivery_offset ?? null);
      const next = template.tasks.map(toDraft);
      setTasks(next);
      setDepartments(overview.departments);
      setCanEdit(Boolean(overview.capabilities.can_manage_plan));
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load template");
    }
  }

  useEffect(() => {
    void load();
  }, [templateId]);

  useEffect(() => {
    hideConnected();
    setTaskMenu(null);
  }, [templateId, hideConnected]);

  useEffect(() => {
    if (!taskMenu) return;
    function close() {
      setTaskMenu(null);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onContext(e: Event) {
      e.preventDefault();
      close();
    }
    const timer = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", onContext);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKey);
    };
  }, [taskMenu]);

  const deliveryCol = useMemo(() => {
    if (direction !== "backward") return 0;
    const offset = deliveryOffset ?? topTasks(tasks).reduce((max, task) => Math.max(max, task.day_offset), 0);
    return templateColOf(offset, zoom);
  }, [direction, deliveryOffset, tasks, zoom]);

  const columns = useMemo(() => {
    const indexes = topTasks(tasks).map((task) => templateColOf(task.day_offset, zoom));
    if (direction === "backward") indexes.push(deliveryCol);
    return templateColumnsSpanning(indexes);
  }, [tasks, zoom, direction, deliveryCol]);

  useLayoutEffect(() => {
    const key = `${templateId || ""}:${zoom}`;
    if (scrolledKey.current === key) return;
    if (!gridWrapRef.current) return;
    scrolledKey.current = key;
    scrollToStart();
  }, [templateId, zoom, columns, loaded]);

  const rows = useMemo(
    () => [...departments, { id: "", name: "Unassigned", color: "#3a3428", member_ids: [] as string[] }],
    [departments],
  );

  const tasksByCell = useMemo(() => {
    const map = new Map<string, DraftTask[]>();
    for (const task of topTasks(tasks)) {
      const key = `${task.department_id || "none"}|${templateColOf(task.day_offset, zoom)}`;
      const list = map.get(key) || [];
      list.push(task);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [tasks, zoom]);

  const paintedKeys = useMemo(() => paintedKeysFromCells(tasksByCell), [tasksByCell]);
  const [dragMove, setDragMove] = useState<{ grabbedKey: string; keys: string[] } | null>(null);
  const dragMoveRef = useRef<{ grabbedKey: string; keys: string[] } | null>(null);
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const selection = usePlanSelection({
    enabled: canEdit && !pickingDeps,
    wrapRef: gridWrapRef,
    paintedIds: paintedKeys,
    canSelectId: () => canEdit,
    resetKey: templateId || "",
  });

  function cellKey(departmentId: string, col: number): string {
    return `${departmentId || "none"}|${col}`;
  }

  function changeZoom(next: PlanZoom) {
    setZoom(next);
    writeZoom(ZOOM_KEY, next);
  }

  function scrollPlanHeader(selector: string) {
    const target = gridWrapRef.current?.querySelector(selector);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: "nearest", inline: "center" });
    return true;
  }

  function scrollToStart() {
    if (!scrollPlanHeader('[data-plan-col="0"]')) scrollPlanHeader(".plan-week");
  }

  async function persist(
    nextName: string,
    nextTasks: DraftTask[],
    nextDirection: ScheduleDirection = direction,
    nextDelivery: number | null = deliveryOffset,
  ) {
    if (!templateId) return null;
    setBusy(true);
    setError("");
    try {
      const saved = await api.savePlanTemplate(templateId, {
        name: nextName.trim() || name,
        schedule_direction: nextDirection,
        ...(nextDirection === "backward" && nextDelivery != null ? { delivery_offset: Math.max(0, nextDelivery) } : {}),
        tasks: nextTasks
          .filter((task) => task.title.trim())
          .map((task) => ({
            id: task.id || task.key,
            title: task.title.trim(),
            notes: task.notes.trim() || null,
            department_id: task.department_id || null,
            day_offset: Math.max(0, Number(task.day_offset) || 0),
            notify_days_before: task.parent_key ? null : task.notify_days_before,
            sort_order: task.sort_order,
            predecessor_ids: task.parent_key ? [] : task.predecessor_keys,
            parent_id: task.parent_key || null,
          })),
      });
      setName(saved.name);
      setDirection(saved.schedule_direction === "backward" ? "backward" : "forward");
      setDeliveryOffset(saved.delivery_offset ?? (saved.schedule_direction === "backward" ? 0 : null));
      const nextDrafts = saved.tasks.map(toDraft);
      setTasks(nextDrafts);
      setEditing((prev) => remapEditing(prev, nextDrafts));
      return nextDrafts;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save template");
      await load();
      return null;
    } finally {
      setBusy(false);
    }
  }

  function depKey(task: DraftTask): string {
    return task.id || task.key;
  }

  function editingTaskKey(): string | null {
    return editing && editing !== "new" ? editing.key : null;
  }

  function isPickedDep(task: DraftTask): boolean {
    return draft.predecessor_keys.includes(depKey(task)) || draft.predecessor_keys.includes(task.key);
  }

  function startPickingDeps() {
    hideConnected();
    pickSnapshot.current = draft.predecessor_keys;
    setPickingDeps(true);
  }

  function beginShowConnected(chain: ConnectedIds) {
    if (pickingDeps) cancelPickedDeps();
    showConnected(chain);
    setTaskMenu(null);
  }

  function onTaskContextMenu(e: MouseEvent<HTMLButtonElement>, task: DraftTask) {
    e.preventDefault();
    e.stopPropagation();
    selection.onChipContextMenu(task.key);
    setTaskMenu({ task, x: e.clientX, y: e.clientY, chain: walkTemplateConnected(task, topTasks(tasks)) });
  }

  function togglePickedDep(task: DraftTask) {
    if (task.key === editingTaskKey()) return;
    const key = depKey(task);
    setDraft((prev) => {
      const has = prev.predecessor_keys.includes(key) || prev.predecessor_keys.includes(task.key);
      return {
        ...prev,
        predecessor_keys: has
          ? prev.predecessor_keys.filter((item) => item !== key && item !== task.key)
          : [...prev.predecessor_keys, key],
      };
    });
  }

  function confirmPickedDeps() {
    setPickingDeps(false);
  }

  function cancelPickedDeps() {
    setDraft((prev) => ({ ...prev, predecessor_keys: pickSnapshot.current }));
    setPickingDeps(false);
  }

  function closeEditor() {
    setPickingDeps(false);
    setEditing(null);
    setSubtaskDraft("");
  }

  function selectedDepTasks(): DraftTask[] {
    const keys = new Set(draft.predecessor_keys);
    return topTasks(tasks).filter((task) => keys.has(depKey(task)) || keys.has(task.key));
  }

  function openNew(departmentId: string, col: number) {
    if (!canEdit || pickingDeps) return;
    setTitleFocusGen((n) => n + 1);
    setEditing("new");
    setDraft({
      title: "",
      notes: "",
      department_id: departmentId,
      day_offset: templateNewOffset(col, zoom),
      notify_days: "",
      predecessor_keys: [],
    });
    setSubtaskDraft("");
  }

  function openEdit(task: DraftTask) {
    if (pickingDeps) {
      togglePickedDep(task);
      return;
    }
    if (editing === "new" || !editing || editing.key !== task.key) {
      setTitleFocusGen((n) => n + 1);
    }
    setEditing(task);
    setDraft({
      title: task.title,
      notes: task.notes,
      department_id: task.department_id,
      day_offset: task.day_offset,
      notify_days: notifyDaysInput(task.notify_days_before),
      predecessor_keys: task.predecessor_keys,
    });
    setSubtaskDraft("");
  }

  async function saveTask(e: FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    const title = draft.title.trim();
    if (!title) return;
    const parsedNotify = parseNotifyDays(draft.notify_days);
    if (parsedNotify === "invalid") {
      setError("Notify days must be 0–365, or empty to turn off.");
      return;
    }
    const isChild = Boolean(editing && editing !== "new" && editing.parent_key);
    const parent =
      isChild && editing && editing !== "new"
        ? tasks.find((task) => parentKeysOf(task).has(editing.parent_key))
        : null;
    const tops = topTasks(tasks);
    const nextTask: DraftTask = {
      key: editing === "new" || !editing ? `tmp-${Date.now()}` : editing.key,
      id: editing === "new" || !editing ? undefined : editing.id,
      title,
      notes: draft.notes,
      department_id: isChild && parent ? parent.department_id : draft.department_id,
      day_offset: isChild && parent ? parent.day_offset : Math.max(0, draft.day_offset),
      notify_days_before: isChild ? null : parsedNotify,
      predecessor_keys: isChild ? [] : draft.predecessor_keys,
      parent_key: isChild && editing && editing !== "new" ? editing.parent_key : "",
      sort_order:
        editing === "new" || !editing
          ? nextDeptSort(tops, draft.department_id, (task) => task.department_id, (task) => task.sort_order)
          : isChild
            ? editing.sort_order
            : editing.department_id !== draft.department_id
              ? nextDeptSort(
                  tops.filter((task) => task.key !== editing.key),
                  draft.department_id,
                  (task) => task.department_id,
                  (task) => task.sort_order,
                )
              : editing.sort_order,
    };
    const next =
      editing === "new" || !editing
        ? [...tasks, nextTask]
        : withChildrenFollowing(tasks.map((task) => (task.key === nextTask.key ? nextTask : task)));
    if (isChild) {
      setTasks(next);
      await persist(name, next);
      return;
    }
    closeEditor();
    setTasks(next);
    await persist(name, next);
  }

  async function removeTask(task: DraftTask) {
    const kids = childrenOf(tasks, task);
    const label =
      !task.parent_key && kids.length
        ? `Delete “${task.title}” and ${kids.length} ${kids.length === 1 ? "subtask" : "subtasks"}?`
        : `Delete “${task.title}”?`;
    if (!confirm(label)) return;
    const removing = parentKeysOf(task);
    for (const child of kids) {
      removing.add(child.key);
      if (child.id) removing.add(child.id);
    }
    const next = tasks
      .filter((row) => !removing.has(row.key) && !(row.id && removing.has(row.id)))
      .map((row) => ({
        ...row,
        predecessor_keys: row.predecessor_keys.filter((key) => !removing.has(key)),
      }));
    closeEditor();
    setTasks(next);
    await persist(name, next);
  }

  async function addSubtask(parent: DraftTask) {
    if (!canEdit || parent.parent_key) return;
    const child: DraftTask = {
      key: `tmp-${Date.now()}`,
      title: "New subtask",
      notes: "",
      department_id: parent.department_id,
      day_offset: parent.day_offset,
      notify_days_before: null,
      predecessor_keys: [],
      sort_order: nextChildSort(tasks, parent),
      parent_key: parent.key,
    };
    const next = [...tasks, child];
    setTaskMenu(null);
    setTasks(next);
    openEdit(parent);
    await persist(name, next);
  }

  async function submitSubtask() {
    if (!canEdit || !editing || editing === "new" || editing.parent_key) return;
    const title = subtaskDraft.trim();
    if (!title) return;
    const child: DraftTask = {
      key: `tmp-${Date.now()}`,
      title,
      notes: "",
      department_id: editing.department_id,
      day_offset: editing.day_offset,
      notify_days_before: null,
      predecessor_keys: [],
      sort_order: nextChildSort(tasks, editing),
      parent_key: editing.key,
    };
    const next = [...tasks, child];
    setSubtaskDraft("");
    setTasks(next);
    await persist(name, next);
  }

  function onTaskDragStart(e: DragEvent, task: DraftTask) {
    if (!canEdit || pickingDeps || selection.consumeDragStart()) {
      e.preventDefault();
      return;
    }
    const multi = selection.selectedIds.has(task.key) && selection.selectedIds.size > 1;
    const keys = multi ? [...selection.selectedIds] : [task.key];
    if (!selection.selectedIds.has(task.key)) selection.onChipContextMenu(task.key);
    e.dataTransfer.setData(TASK_MIME, task.key);
    e.dataTransfer.setData("text/plain", task.key);
    e.dataTransfer.effectAllowed = "move";
    draggingKey.current = task.key;
    const nextMove = { grabbedKey: task.key, keys };
    dragMoveRef.current = nextMove;
    setDragMove(nextMove);
    if (keys.length > 1 && e.currentTarget instanceof HTMLElement) {
      setCountDragImage(e.dataTransfer, e.currentTarget, keys.length - 1);
    }
  }

  function clearDragUi() {
    draggingKey.current = null;
    draggingDelivery.current = false;
    dragMoveRef.current = null;
    setDragMove(null);
    setHoverCol(null);
    setDropKey(null);
    setDropChipKey(null);
  }

  async function onCellDrop(e: DragEvent, departmentId: string, col: number, beforeKey?: string) {
    e.preventDefault();
    if (isDeliveryDrag(e)) {
      clearDragUi();
      await dropDelivery(col);
      return;
    }
    const key = e.dataTransfer.getData(TASK_MIME) || draggingKey.current;
    const move = dragMoveRef.current;
    clearDragUi();
    if (!key || !canEdit || pickingDeps) return;
    const setKeys = move && move.grabbedKey === key && move.keys.length > 1 ? move.keys : null;
    if (setKeys) {
      const dragged = tasks.find((task) => task.key === key);
      if (!dragged) return;
      const delta = col - templateColOf(dragged.day_offset, zoom);
      if (!delta) return;
      const movingIds = new Set(setKeys);
      const shifted = applyTimeBlockShift({
        items: topTasks(tasks),
        movingIds,
        idOf: (task) => task.key,
        deptOf: (task) => task.department_id,
        columnOf: (task) => templateColOf(task.day_offset, zoom),
        shift: (task) => ({
          ...task,
          day_offset: templateDropOffset(task.day_offset, templateColOf(task.day_offset, zoom) + delta, zoom),
        }),
      });
      const next = withChildrenFollowing(mergeUpdated(tasks, shifted));
      setTasks(next);
      await persist(name, next);
      return;
    }
    if (beforeKey && beforeKey === key) return;
    const tops = topTasks(tasks);
    const dragged = tops.find((task) => task.key === key);
    if (!dragged) return;
    const moved: DraftTask = {
      ...dragged,
      department_id: departmentId,
      day_offset: templateDropOffset(dragged.day_offset, col, zoom),
    };
    const relocated = tops.map((task) => (task.key === key ? moved : task));
    const insertBefore = cellInsertBeforeId({
      items: relocated,
      draggedId: key,
      departmentId,
      column: col,
      dropOnId: beforeKey || null,
      idOf: (task) => task.key,
      deptOf: (task) => task.department_id,
      sortOf: (task) => task.sort_order,
      columnOf: (task) => templateColOf(task.day_offset, zoom),
    });
    const ordered = orderDepartmentIds({
      items: relocated,
      draggedId: key,
      departmentId,
      beforeId: insertBefore,
      idOf: (task) => task.key,
      deptOf: (task) => task.department_id,
      sortOf: (task) => task.sort_order,
    });
    const next = withChildrenFollowing(
      mergeUpdated(tasks, applyDepartmentSort(relocated, departmentId, ordered, (task) => task.key, (task) => task.department_id)),
    );
    setTasks(next);
    await persist(name, next);
  }

  async function commitName() {
    const next = name.trim();
    if (!next || !canEdit) return;
    await persist(next, tasks);
  }

  async function changeDirection(next: ScheduleDirection) {
    if (next === direction || !canEdit) return;
    let offset = deliveryOffset;
    if (next === "backward" && offset == null) {
      offset = topTasks(tasks).reduce((max, task) => Math.max(max, Math.max(0, task.day_offset)), 0);
    }
    setDirection(next);
    if (offset != null) setDeliveryOffset(offset);
    await persist(name, tasks, next, offset);
  }

  function onDeliveryDragStart(e: DragEvent) {
    if (!canEdit || direction !== "backward") {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(DELIVERY_MIME, "delivery");
    e.dataTransfer.setData("text/plain", "delivery");
    e.dataTransfer.effectAllowed = "move";
    draggingDelivery.current = true;
  }

  async function dropDelivery(col: number) {
    if (!canEdit || direction !== "backward") return;
    const current = deliveryOffset ?? 0;
    const next =
      deliveryOffset == null ? templateNewOffset(col, zoom) : templateDropOffset(current, col, zoom);
    if (next === current && deliveryOffset != null) return;
    setDeliveryOffset(next);
    await persist(name, tasks, direction, next);
  }

  function isDeliveryDrag(e: DragEvent) {
    return draggingDelivery.current || [...e.dataTransfer.types].includes(DELIVERY_MIME);
  }
  const hiddenConnected = connected ? hiddenConnectedCount(connected, paintedKeys) : 0;
  const destDropKeys = useMemo(() => {
    if (!dragMove || dragMove.keys.length < 2 || hoverCol == null) return null;
    const grabbed = tasks.find((task) => task.key === dragMove.grabbedKey);
    if (!grabbed) return null;
    const delta = hoverCol - templateColOf(grabbed.day_offset, zoom);
    const keys = new Set<string>();
    for (const key of dragMove.keys) {
      const task = tasks.find((row) => row.key === key);
      if (!task) continue;
      const dest = templateColOf(task.day_offset, zoom) + delta;
      keys.add(`${task.department_id || "none"}|${Math.max(0, dest)}`);
    }
    return keys;
  }, [dragMove, hoverCol, tasks, zoom]);
  const spanOffset = useMemo(() => {
    let max = 0;
    for (const task of topTasks(tasks)) {
      if (editing && editing !== "new" && editing.key === task.key) continue;
      max = Math.max(max, Math.max(0, task.day_offset));
    }
    return Math.max(max, Math.max(0, draft.day_offset));
  }, [tasks, editing, draft.day_offset]);
  const deliveryDays = direction === "backward" ? (deliveryOffset ?? spanOffset) : 0;
  const fromDelivery = Math.max(0, draft.day_offset) - deliveryDays;
  const editorSource = direction === "backward" ? fromDelivery : draft.day_offset;
  const editorValue = zoom === "day" ? editorSource : Math.floor(editorSource / unit);
  const editorRemainder = zoom === "day" ? 0 : editorSource - editorValue * unit;
  const editorLabel =
    direction === "backward"
      ? zoom === "day"
        ? "Days from delivery"
        : zoom === "week"
          ? "Weeks from delivery"
          : "Months from delivery"
      : zoom === "day"
        ? "Days after start"
        : zoom === "week"
          ? "Weeks after start"
          : "Months after start";
  const zoomHint =
    direction === "backward"
      ? zoom === "day"
        ? "Drag Delivery onto a column. Tasks after it stay after delivery when you create a project."
        : zoom === "week"
          ? "Drag Delivery onto a week. Dropping keeps the weekday. Later weeks stay after delivery."
          : "Drag Delivery onto a month. Dropping keeps the day within the 4-week month."
      : zoom === "day"
        ? "Columns are days after a project starts."
        : zoom === "week"
          ? "Columns are weeks after a project starts. Dropping keeps the weekday."
          : "Columns are 4-week months after a project starts. Dropping keeps the day within the month.";
  const isChild = Boolean(editing && editing !== "new" && editing.parent_key);
  const showSubtasks = Boolean(editing && editing !== "new" && !editing.parent_key);
  const editorChildren = showSubtasks && editing && editing !== "new" ? childrenOf(tasks, editing) : [];

  function setEditorOffset(next: number) {
    const amount = next * unit + editorRemainder;
    if (direction === "backward") {
      setDraft({ ...draft, day_offset: Math.max(0, deliveryDays + amount) });
      return;
    }
    setDraft({ ...draft, day_offset: Math.max(0, amount) });
  }

  return (
    <div className="shell">
      <OrgSidebar active="template" />
      <main className="main plan">
        <div className="main-head plan-toolbar">
          <div>
            <Link className="hint plan-back" to="/org">
              ← <span className="plan-back-full">Organization</span>
              <span className="plan-back-short">Org</span>
            </Link>
            {canEdit ? (
              <input
                className="plan-title-input"
                value={name}
                maxLength={120}
                aria-label="Template name"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void commitName()}
              />
            ) : (
              <h1>{name || "Template"}</h1>
            )}
            <p className="hint plan-toolbar-lead" style={{ margin: "4px 0 0" }}>
              {zoomHint} Drag tasks onto a department and column.
            </p>
          </div>
          <div className="composer-row">
            <div className="plan-zoom" role="group" aria-label="Schedule from">
              <button
                className={`btn ghost small${direction === "forward" ? " on" : ""}`}
                type="button"
                disabled={!canEdit}
                onClick={() => void changeDirection("forward")}
              >
                From start
              </button>
              <button
                className={`btn ghost small${direction === "backward" ? " on" : ""}`}
                type="button"
                disabled={!canEdit}
                onClick={() => void changeDirection("backward")}
              >
                From delivery
              </button>
            </div>
            <div className="plan-zoom" role="group" aria-label="Zoom">
              {ZOOM_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  className={`btn ghost small${zoom === opt.id ? " on" : ""}`}
                  type="button"
                  onClick={() => changeZoom(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button className="btn ghost small" type="button" onClick={() => scrollToStart()}>
              Start
            </button>
            {direction === "backward" ? (
              <button
                className="btn ghost small"
                type="button"
                onClick={() => scrollPlanHeader(`[data-plan-col="${deliveryCol}"]`)}
              >
                Delivery
              </button>
            ) : null}
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {busy ? <p className="hint">Saving…</p> : null}
        {connected ? <ShowConnectedBanner hiddenCount={hiddenConnected} onDismiss={hideConnected} /> : null}
        {!loaded ? (
          <p className="hint">Loading…</p>
        ) : (
          <div
            ref={gridWrapRef}
            className={`plan-grid-wrap${pickingDeps ? " picking-deps" : ""}${connected ? " showing-connected" : ""}${selection.selecting ? " plan-selecting" : ""}`}
            onClick={(e) => {
              if (selection.onWrapClick(e)) return;
              if (connected) connectedGridClick(e, hideConnected);
            }}
          >
            <div
              className="plan-grid"
              style={{
                ["--weeks" as string]: columns.length,
                ["--plan-col-min" as string]: zoom === "day" ? "108px" : "148px",
              }}
            >
              <div className="plan-corner">
                <span className="plan-corner-label">Department</span>
              </div>
              {columns.map((col) => (
                <div
                  className={`plan-week${direction === "backward" && col === deliveryCol ? " delivery" : ""}`}
                  data-plan-col={col}
                  key={col}
                  onDragOver={(e) => {
                    if (!canEdit || !isDeliveryDrag(e)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setHoverCol(col);
                  }}
                  onDrop={(e) => {
                    if (!isDeliveryDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    draggingDelivery.current = false;
                    void dropDelivery(col);
                  }}
                >
                  <strong
                    className={direction === "backward" && col === deliveryCol && canEdit ? "plan-delivery-handle" : undefined}
                    draggable={canEdit && direction === "backward" && col === deliveryCol}
                    onDragStart={onDeliveryDragStart}
                    onDragEnd={() => {
                      draggingDelivery.current = false;
                      setHoverCol(null);
                    }}
                  >
                    {templateHeading(col, zoom, direction, deliveryCol)}
                  </strong>
                </div>
              ))}
              {rows.map((dept) => {
                const deptId = dept.id || "";
                return [
                  <div
                    className="plan-dept"
                    key={`d-${dept.id || "none"}`}
                    style={{ background: `color-mix(in srgb, ${dept.color} 35%, var(--bg-raised))` }}
                  >
                    <span className="dot" style={{ background: dept.color }} />
                    <span className="plan-dept-name">{dept.name}</span>
                  </div>,
                  ...columns.map((col) => {
                    const key = cellKey(deptId, col);
                    const cellTasks = tasksByCell.get(key) || [];
                    return (
                      <div
                        className={`plan-cell${destDropKeys?.has(key) || (dropKey === key && !destDropKeys) ? " drag-over" : ""}`}
                        key={key}
                        onPointerDown={(e) => selection.onCellPointerDown(e)}
                        onDragOver={(e) => {
                          if (!canEdit || pickingDeps) return;
                          if (isDeliveryDrag(e)) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            setHoverCol(col);
                            setDropKey(key);
                            setDropChipKey(null);
                            return;
                          }
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          setHoverCol(col);
                          if (dragMoveRef.current && dragMoveRef.current.keys.length > 1) {
                            setDropKey(null);
                            setDropChipKey(null);
                            return;
                          }
                          setDropKey(key);
                          setDropChipKey(null);
                        }}
                        onDragLeave={() => setDropKey((cur) => (cur === key ? null : cur))}
                        onDrop={(e) => void onCellDrop(e, deptId, col)}
                        onDoubleClick={() => {
                          if (!pickingDeps) openNew(deptId, col);
                        }}
                      >
                        {cellTasks.map((task) => {
                          const n = childrenOf(tasks, task).length;
                          return (
                          <button
                            key={task.key}
                            type="button"
                            data-plan-chip-id={task.key}
                            className={`plan-chip${task.predecessor_keys.length ? " blocked" : ""}${selection.isSelected(task.key) ? " selected" : ""}${pickingDeps && isPickedDep(task) ? " dep-picked" : ""}${pickingDeps && task.key === editingTaskKey() ? " dep-source" : ""}${dropChipKey === task.key ? " drop-before" : ""}${connectedChipClass(task.key, connected)}`}
                            style={{ background: `color-mix(in srgb, ${dept.color} 28%, var(--bg-card))` }}
                            draggable={canEdit && !pickingDeps}
                            onPointerDown={(e) => selection.onChipPointerDown(e)}
                            onDragStart={(e) => onTaskDragStart(e, task)}
                            onDragEnd={() => clearDragUi()}
                            onDragOver={(e) => {
                              if (!canEdit || pickingDeps) return;
                              if (draggingKey.current === task.key) return;
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
                              setHoverCol(col);
                              if (dragMoveRef.current && dragMoveRef.current.keys.length > 1) {
                                setDropChipKey(null);
                                setDropKey(null);
                                return;
                              }
                              setDropChipKey(task.key);
                              setDropKey(null);
                            }}
                            onDragLeave={(e) => {
                              const next = e.relatedTarget as Node | null;
                              if (next && e.currentTarget.contains(next)) return;
                              setDropChipKey((cur) => (cur === task.key ? null : cur));
                            }}
                            onDrop={(e) => {
                              e.stopPropagation();
                              void onCellDrop(e, deptId, col, task.key);
                            }}
                            onClick={(e) => {
                              const next = selection.onChipClick(e, task.key);
                              if (next.open) openEdit(task);
                            }}
                            onContextMenu={(e) => onTaskContextMenu(e, task)}
                          >
                            <span className="plan-chip-top">
                              <span className="plan-chip-title">{task.title || "Untitled"}</span>
                              {n ? (
                                <span className="plan-chip-progress" title={`${n} ${n === 1 ? "subtask" : "subtasks"}`}>
                                  {n}
                                </span>
                              ) : null}
                            </span>
                            {task.predecessor_keys.length ? (
                              <span className="hint">Depends on {task.predecessor_keys.length}</span>
                            ) : null}
                          </button>
                          );
                        })}
                        {canEdit && !pickingDeps ? (
                          <button className="plan-add" type="button" onClick={() => openNew(deptId, col)}>
                            +
                          </button>
                        ) : null}
                      </div>
                    );
                  }),
                ];
              })}
            </div>
            {selection.marquee ? (
              <div
                className="plan-marquee"
                style={{
                  left: selection.marquee.left,
                  top: selection.marquee.top,
                  width: selection.marquee.right - selection.marquee.left,
                  height: selection.marquee.bottom - selection.marquee.top,
                }}
              />
            ) : null}
          </div>
        )}

        {editing && pickingDeps ? (
          <div className="plan-editor plan-dep-picker">
            <div className="panel">
              <h2>Assign depending tasks</h2>
              <p className="hint">
                Click one or more other tasks on the board. Those become the tasks this one depends on.
              </p>
              <p>
                Selected: {draft.predecessor_keys.length}{" "}
                {draft.predecessor_keys.length === 1 ? "task" : "tasks"}
                {selectedDepTasks().length
                  ? ` — ${selectedDepTasks()
                      .map((task) => task.title || "Untitled")
                      .join(", ")}`
                  : ""}
              </p>
              <div className="composer-row">
                <button className="btn" type="button" onClick={confirmPickedDeps}>
                  Confirm
                </button>
                <button className="btn ghost" type="button" onClick={cancelPickedDeps}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : editing ? (
          <div className="plan-editor">
            <div className={`plan-editor-layout${showSubtasks ? " has-subtasks" : ""}`}>
            <form className="panel" onSubmit={(e) => void saveTask(e)}>
              <h2>{editing === "new" ? "New task" : isChild ? "Subtask" : "Task"}</h2>
              <label>
                Title
                <input
                  ref={titleRef}
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  required
                  maxLength={500}
                  disabled={!canEdit}
                />
              </label>
              <label>
                Notes
                <textarea
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  rows={3}
                  disabled={!canEdit}
                />
              </label>
              {canEdit && !isChild ? (
                <>
                  <label>
                    Department
                    <select
                      value={draft.department_id}
                      onChange={(e) => setDraft({ ...draft, department_id: e.target.value })}
                    >
                      <option value="">Unassigned</option>
                      {departments.map((dept) => (
                        <option key={dept.id} value={dept.id}>
                          {dept.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {editorLabel}
                    <input
                      type="number"
                      min={
                        direction === "backward"
                          ? zoom === "day"
                            ? -deliveryDays
                            : Math.floor(-deliveryDays / unit)
                          : 0
                      }
                      max={
                        zoom === "day"
                          ? 365
                          : zoom === "week"
                            ? 52
                            : 24
                      }
                      value={editorValue}
                      onChange={(e) => setEditorOffset(Number(e.target.value) || 0)}
                    />
                  </label>
                  {direction === "backward" ? (
                    <p className="hint">Negative is before delivery, 0 is delivery, positive is after.</p>
                  ) : null}
                  <label className="plan-notify">
                    Notify
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="off"
                      value={draft.notify_days}
                      aria-label="Days before due to email"
                      onChange={(e) => setDraft({ ...draft, notify_days: e.target.value })}
                      disabled={!canEdit}
                    />
                    days before due
                  </label>
                  <p className="hint">Assignee, or department leads if unassigned, get the email.</p>
                  <div className="plan-dep-field">
                    <span>Depends on</span>
                    {selectedDepTasks().length ? (
                      <ul className="plan-dep-list">
                        {selectedDepTasks().map((task) => (
                          <li key={task.key}>{task.title || "Untitled"}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="hint">No depending tasks yet.</p>
                    )}
                    <button className="btn" type="button" onClick={startPickingDeps}>
                      Assign depending tasks
                    </button>
                  </div>
                </>
              ) : null}
              <div className="composer-row">
                {canEdit ? (
                  <button className="btn" type="submit" disabled={busy}>
                    Save
                  </button>
                ) : null}
                {canEdit && editing !== "new" ? (
                  <button className="btn ghost" type="button" onClick={() => void removeTask(editing)}>
                    Delete
                  </button>
                ) : null}
                <button className="btn ghost" type="button" onClick={closeEditor}>
                  Close
                </button>
              </div>
            </form>
            {showSubtasks ? (
              <div className="panel plan-subtasks">
                <h2>Subtasks</h2>
                {editorChildren.length ? (
                  <ul className="plan-subtask-list">
                    {editorChildren.map((child) => (
                      <li key={child.key}>
                        <button type="button" className="plan-subtask-row" onClick={() => openEdit(child)}>
                          <span className="plan-subtask-title">{child.title || "Untitled"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">No subtasks yet.</p>
                )}
                {canEdit ? (
                  <div className="composer-row plan-subtask-add">
                    <input
                      value={subtaskDraft}
                      onChange={(e) => setSubtaskDraft(e.target.value)}
                      placeholder="Add subtask"
                      maxLength={500}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitSubtask();
                        }
                      }}
                    />
                    <button className="btn" type="button" onClick={() => void submitSubtask()}>
                      Add
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            </div>
          </div>
        ) : null}
        {taskMenu ? (
          <div
            className="color-menu"
            style={{
              left: Math.max(12, Math.min(taskMenu.x, window.innerWidth - 180)),
              top: Math.max(12, Math.min(taskMenu.y, window.innerHeight - 160)),
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {canEdit && !taskMenu.task.parent_key ? (
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  const task = taskMenu.task;
                  setTaskMenu(null);
                  void addSubtask(task);
                }}
              >
                Add subtask
              </button>
            ) : null}
            <ShowConnectedMenuItem
              isSource={connected?.sourceId === taskMenu.task.key}
              chain={taskMenu.chain}
              onShow={beginShowConnected}
              onHide={() => {
                hideConnected();
                setTaskMenu(null);
              }}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
