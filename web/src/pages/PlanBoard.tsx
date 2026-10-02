import { type DragEvent, type FormEvent, type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Membership, type PlanBoard as PlanBoardData, type PlanSubtask, type PlanTask } from "../api";
import { memberLabel } from "../components/PlanAssigneeSelect";
import OrgSidebar from "../components/OrgSidebar";
import PlanTaskEditor, { notifyDaysInput, parseNotifyDays } from "../components/PlanTaskEditor";
import PlanWhoResizeHandle from "../components/PlanWhoResizeHandle";
import { PlanProjectSpans, PlanViewSwitch, PlanWorkloadBar } from "../components/PlanWorkloadBar";
import { LightboxOverlay, lightboxFor, type Lightbox } from "../components/ItemCard";
import { DeliveryMoveDialog, type DeliveryMovePrompt } from "../components/DeliveryMoveDialog";
import { ShiftRelatedDialog, useShiftFlow } from "../components/ShiftRelatedDialog";
import { ShowConnectedBanner, ShowConnectedMenuItem } from "../components/ShowConnected";
import { departmentBoardRows, departmentFocusRows, DepartmentViewMenu, type PlanGridRow } from "../departmentFocus";
import {
  connectedChipClass,
  connectedGridClick,
  hiddenConnectedCount,
  paintedIdsFromCells,
  useConnectedOverlay,
  useLiveConnectedMenu,
  type ConnectedIds,
} from "../planConnected";
import { cellAppendBlockBeforeId, cellInsertBeforeId } from "../planOrder";
import { projectSpans } from "../planSpan";
import { setCountDragImage, usePlanSelection } from "../planSelect";
import { useWhoColumnWidth } from "../planWhoWidth";
import { usePlanView } from "../planWorkload";
import { useLiveReload } from "../live";
import {
  ZOOM_OPTIONS,
  addDays,
  dayDelta,
  defaultHeaderMode,
  deliveryDueOnColumn,
  dropDueOn,
  formatStackedProjectHeader,
  isCurrentPlanColumn,
  isDeliveryPlanColumn,
  newTaskDueOn,
  parseYmd,
  planColumnDelta,
  projectColumnKey,
  projectColumnsSpanning,
  projectTaskColumnKey,
  readHeaderMode,
  readZoom,
  shiftDueByColumns,
  taskDueOn,
  writeHeaderMode,
  writeZoom,
  ymd,
  type PlanHeaderMode,
  type PlanZoom,
} from "../planZoom";

const TASK_MIME = "application/x-magictodo-plan-task";
const DELIVERY_MIME = "application/x-magictodo-delivery";
const ZOOM_KEY = "magictodo:plan-zoom:project";

function hideDoneKey(projectId: string): string {
  return `magictodo:plan-hide-done:${projectId}`;
}

function readHideDone(projectId: string | undefined): boolean {
  if (!projectId) return false;
  try {
    return localStorage.getItem(hideDoneKey(projectId)) === "1";
  } catch {
    return false;
  }
}

function writeHideDone(projectId: string, hide: boolean): void {
  try {
    localStorage.setItem(hideDoneKey(projectId), hide ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function ProgressBadge({ percent }: { percent: number }) {
  const radius = 7;
  const circ = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, percent)) / 100) * circ;
  return (
    <span className="plan-chip-progress" title={`${percent}% done`}>
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="3" opacity="0.28" />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
      {percent}%
    </span>
  );
}

function undoneBlockingTasks(task: PlanTask, all: PlanTask[]): PlanTask[] {
  const byId = new Map(all.map((row) => [row.id, row]));
  const found: PlanTask[] = [];
  const seen = new Set<string>();
  const queue = [...task.predecessor_ids];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id) || id === task.id) continue;
    seen.add(id);
    const pred = byId.get(id);
    if (!pred || pred.status === "done") continue;
    found.push(pred);
    queue.push(...pred.predecessor_ids);
  }
  return found;
}

function successorIndex(all: PlanTask[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const task of all) {
    for (const predId of task.predecessor_ids) {
      const list = map.get(predId) || [];
      list.push(task.id);
      map.set(predId, list);
    }
  }
  return map;
}

function undoneFollowingTasks(task: PlanTask, all: PlanTask[]): PlanTask[] {
  const byId = new Map(all.map((row) => [row.id, row]));
  const succs = successorIndex(all);
  const found: PlanTask[] = [];
  const seen = new Set<string>();
  const queue = [...(succs.get(task.id) || [])];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id) || id === task.id) continue;
    seen.add(id);
    const next = byId.get(id);
    if (!next || next.status === "done") continue;
    found.push(next);
    queue.push(...(succs.get(id) || []));
  }
  return found;
}

function relatedUnion(
  selected: PlanTask[],
  all: PlanTask[],
  canManage: (task: PlanTask) => boolean,
): { upstream: PlanTask[]; following: PlanTask[] } {
  const selectedIds = new Set(selected.map((task) => task.id));
  const upstream: PlanTask[] = [];
  const following: PlanTask[] = [];
  const seenUp = new Set<string>();
  const seenFollow = new Set<string>();
  for (const task of selected) {
    for (const row of undoneBlockingTasks(task, all)) {
      if (selectedIds.has(row.id) || !canManage(row) || seenUp.has(row.id)) continue;
      seenUp.add(row.id);
      upstream.push(row);
    }
    for (const row of undoneFollowingTasks(task, all)) {
      if (selectedIds.has(row.id) || !canManage(row) || seenFollow.has(row.id)) continue;
      seenFollow.add(row.id);
      following.push(row);
    }
  }
  return { upstream, following };
}

export default function PlanBoard() {
  const { projectId, departmentId: focusDepartmentId } = useParams();
  const navigate = useNavigate();
  const whoColumn = useWhoColumnWidth();
  const [planView, setPlanView] = usePlanView();
  const [data, setData] = useState<PlanBoardData | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<PlanZoom>(() => readZoom(ZOOM_KEY));
  const [editing, setEditing] = useState<PlanTask | "new" | null>(null);
  const [titleFocusGen, setTitleFocusGen] = useState(0);
  const [draft, setDraft] = useState({
    title: "",
    notes: "",
    department_id: "",
    assignee_user_id: "",
    due_on: ymd(new Date()),
    notify_days: "",
    predecessor_ids: [] as string[],
  });
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [dropChipId, setDropChipId] = useState<string | null>(null);
  const draggingId = useRef<string | null>(null);
  const draggingDelivery = useRef(false);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const scrolledKey = useRef<string | null>(null);
  const [pickingDeps, setPickingDeps] = useState(false);
  const pickSnapshot = useRef<string[]>([]);
  const { shiftPrompt, shiftBusy, beginShiftFlow, resolveShiftPrompt } = useShiftFlow();
  const [projectName, setProjectName] = useState("");
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [hideDone, setHideDone] = useState(() => readHideDone(projectId));
  const { taskMenu, setTaskMenu, closeTaskMenu, onTaskContextMenu: openConnectedMenu } = useLiveConnectedMenu();
  const { connected, showConnected, hideConnected } = useConnectedOverlay(gridWrapRef, [
    planView,
    hideDone,
    focusDepartmentId,
  ]);
  const [deptMenu, setDeptMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [subtaskDraft, setSubtaskDraft] = useState({ title: "", assignee_user_id: "" });
  const [deliveryDraft, setDeliveryDraft] = useState("");
  const [headerMode, setHeaderMode] = useState<PlanHeaderMode>("calendar");
  const [deliveryPrompt, setDeliveryPrompt] = useState<DeliveryMovePrompt | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const admin = Boolean(data?.capabilities.can_manage_plan);
  const canManageWork = Boolean(data?.capabilities.can_manage_project_work || admin);
  const leadIds = data?.lead_department_ids ?? [];

  function canManageDept(departmentId: string | null | undefined): boolean {
    if (canManageWork) return true;
    if (!departmentId) return false;
    return leadIds.includes(departmentId);
  }

  function canManageTask(task: PlanTask): boolean {
    return Boolean(task.can_manage) || canManageDept(task.department_id);
  }

  function canToggleTaskStatus(task: PlanTask): boolean {
    if (task.status === "done") return true;
    return task.can_complete && !task.blocked;
  }

  async function load() {
    if (!projectId) return;
    setError("");
    try {
      const next = await api.getPlanProject(projectId);
      setData(next);
      setProjectName(next.project.name);
      setEditing((cur) => {
        if (!cur || cur === "new") return cur;
        return next.tasks.find((task) => task.id === cur.id) ?? cur;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load project");
    }
  }

  useEffect(() => {
    void load();
  }, [projectId]);

  useLiveReload(
    (event) => event.channel === "plan" && (!event.project_id || event.project_id === projectId),
    () => load(),
  );

  useEffect(() => {
    setHideDone(readHideDone(projectId));
  }, [projectId]);

  useEffect(() => {
    hideConnected();
  }, [projectId, hideConnected]);

  useEffect(() => {
    setDeliveryDraft(data?.project.delivery_on || "");
  }, [data?.project.delivery_on]);

  useEffect(() => {
    if (!projectId) return;
    if (!data?.project.delivery_on) {
      setHeaderMode("calendar");
      return;
    }
    setHeaderMode(readHeaderMode(projectId, defaultHeaderMode(data.project.schedule_direction)));
  }, [projectId, data?.project.delivery_on, data?.project.schedule_direction]);

  useEffect(() => {
    if (!deliveryPrompt) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") cancelDeliveryMove();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deliveryPrompt]);

  const previewDelivery = deliveryPrompt?.next || data?.project.delivery_on || null;

  const columns = useMemo(() => {
    const dates: string[] = [];
    for (const task of data?.tasks ?? []) {
      if (task.parent_id) continue;
      if (hideDone && task.status === "done") continue;
      dates.push(taskDueOn(task));
    }
    if (previewDelivery) dates.push(previewDelivery);
    return projectColumnsSpanning(dates, zoom);
  }, [data, zoom, hideDone, previewDelivery]);

  useLayoutEffect(() => {
    const key = `${projectId || ""}:${zoom}`;
    if (scrolledKey.current === key) return;
    if (!gridWrapRef.current) return;
    scrolledKey.current = key;
    if (columns.some((col) => isCurrentPlanColumn(col, zoom))) {
      scrollPlanHeader(".plan-week.current");
    }
  }, [projectId, zoom, columns]);

  const tasksByCell = useMemo(() => {
    const map = new Map<string, PlanTask[]>();
    for (const task of data?.tasks ?? []) {
      if (task.parent_id) continue;
      if (hideDone && task.status === "done") continue;
      if (focusDepartmentId && task.department_id !== focusDepartmentId) continue;
      const rowKey = focusDepartmentId ? task.assignee_user_id || "dept" : task.department_id || "none";
      const key = `${rowKey}|${projectTaskColumnKey(taskDueOn(task), zoom)}`;
      const list = map.get(key) || [];
      list.push(task);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [data, zoom, hideDone, focusDepartmentId]);

  const paintedIds = useMemo(() => paintedIdsFromCells(tasksByCell), [tasksByCell]);
  const [dragMove, setDragMove] = useState<{ grabbedId: string; ids: string[] } | null>(null);
  const dragMoveRef = useRef<{ grabbedId: string; ids: string[] } | null>(null);
  const [hoverCol, setHoverCol] = useState<Date | null>(null);
  const selection = usePlanSelection({
    enabled: !pickingDeps && (planView === "cards" || Boolean(connected)),
    wrapRef: gridWrapRef,
    paintedIds,
    canSelectId: (id) => {
      const task = data?.tasks.find((row) => row.id === id);
      return Boolean(task && canManageTask(task));
    },
    resetKey: `${projectId || ""}:${focusDepartmentId || ""}`,
  });

  const columnKeys = useMemo(() => columns.map((col) => projectColumnKey(col, zoom)), [columns, zoom]);

  const spansByRow = useMemo(() => {
    const grouped = new Map<string, PlanTask[]>();
    for (const task of data?.tasks ?? []) {
      if (task.parent_id) continue;
      if (hideDone && task.status === "done") continue;
      if (focusDepartmentId && task.department_id !== focusDepartmentId) continue;
      if (focusDepartmentId) {
        const dept = grouped.get("dept") || [];
        dept.push(task);
        grouped.set("dept", dept);
        if (task.assignee_user_id) {
          const people = grouped.get(task.assignee_user_id) || [];
          people.push(task);
          grouped.set(task.assignee_user_id, people);
        }
      } else {
        const rowKey = task.department_id || "none";
        const list = grouped.get(rowKey) || [];
        list.push(task);
        grouped.set(rowKey, list);
      }
    }
    const fallback = data?.project.name || "Project";
    const map = new Map<string, ReturnType<typeof projectSpans>>();
    for (const [rowKey, tasks] of grouped) {
      map.set(rowKey, projectSpans(tasks, columnKeys, (due) => projectTaskColumnKey(due, zoom), fallback));
    }
    return map;
  }, [data, zoom, hideDone, focusDepartmentId, columnKeys]);

  function cellKey(rowKey: string, col: Date): string {
    return `${rowKey}|${projectColumnKey(col, zoom)}`;
  }

  function editingTaskId(): string | null {
    return editing && editing !== "new" ? editing.id : null;
  }

  function changeZoom(next: PlanZoom) {
    setZoom(next);
    writeZoom(ZOOM_KEY, next);
  }

  function scrollPlanHeader(selector: string) {
    const target = gridWrapRef.current?.querySelector(selector);
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function startPickingDeps() {
    hideConnected();
    pickSnapshot.current = draft.predecessor_ids;
    setPickingDeps(true);
  }

  function beginShowConnected(chain: ConnectedIds) {
    if (pickingDeps) cancelPickedDeps();
    setPlanView("cards");
    showConnected(chain);
    closeTaskMenu();
  }

  function togglePickedDep(taskId: string) {
    if (taskId === editingTaskId()) return;
    setDraft((prev) => {
      const has = prev.predecessor_ids.includes(taskId);
      return {
        ...prev,
        predecessor_ids: has
          ? prev.predecessor_ids.filter((id) => id !== taskId)
          : [...prev.predecessor_ids, taskId],
      };
    });
  }

  function confirmPickedDeps() {
    setPickingDeps(false);
  }

  function cancelPickedDeps() {
    setDraft((prev) => ({ ...prev, predecessor_ids: pickSnapshot.current }));
    setPickingDeps(false);
  }

  function closeEditor() {
    const parentId = editing && editing !== "new" ? editing.parent_id : null;
    setPickingDeps(false);
    setTaskMenu(null);
    if (parentId) {
      const parent = (data?.tasks || []).find((task) => task.id === parentId);
      if (parent) {
        openEdit(parent);
        return;
      }
    }
    setEditing(null);
  }

  async function commitProjectName() {
    const next = projectName.trim();
    if (!next || !admin || !projectId || next === data?.project.name) {
      if (data?.project.name) setProjectName(data.project.name);
      return;
    }
    setError("");
    try {
      const updated = await api.updatePlanProject(projectId, { name: next });
      setProjectName(updated.name);
      setData((prev) => (prev ? { ...prev, project: { ...prev.project, name: updated.name } } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename project");
      if (data?.project.name) setProjectName(data.project.name);
    }
  }

  function changeHeaderMode(next: PlanHeaderMode) {
    setHeaderMode(next);
    if (projectId) writeHeaderMode(projectId, next);
  }

  function cancelDeliveryMove() {
    setDeliveryPrompt(null);
    setDeliveryDraft(data?.project.delivery_on || "");
  }

  async function applyDelivery(next: string | null, moveCards: boolean | null) {
    if (!projectId) return;
    setDeliveryBusy(true);
    setError("");
    try {
      const body: { delivery_on: string | null; move_cards?: boolean } = { delivery_on: next };
      if (moveCards != null) body.move_cards = moveCards;
      const updated = await api.updatePlanProject(projectId, body);
      setDeliveryPrompt(null);
      setDeliveryDraft(updated.delivery_on || "");
      setData((prev) => (prev ? { ...prev, project: { ...prev.project, ...updated } } : prev));
      if (moveCards) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update delivery");
      setDeliveryDraft(data?.project.delivery_on || "");
      setDeliveryPrompt(null);
      await load();
    } finally {
      setDeliveryBusy(false);
    }
  }

  function proposeDelivery(next: string) {
    const prev = data?.project.delivery_on || null;
    if (!next) return;
    if (!prev) {
      void applyDelivery(next, null);
      return;
    }
    if (next === prev) return;
    const offsetDays = dayDelta(prev, next);
    if (!offsetDays) {
      void applyDelivery(next, false);
      return;
    }
    setDeliveryDraft(next);
    setDeliveryPrompt({ previous: prev, next, offsetDays });
  }

  function commitDeliveryField() {
    if (!canManageWork || deliveryPrompt) return;
    const current = data?.project.delivery_on || "";
    const next = deliveryDraft.trim();
    if (next === current) return;
    if (!next) {
      if (current) void applyDelivery(null, null);
      return;
    }
    proposeDelivery(next);
  }

  function onDeliveryDragStart(e: DragEvent) {
    if (!canManageWork) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(DELIVERY_MIME, "delivery");
    e.dataTransfer.setData("text/plain", "delivery");
    e.dataTransfer.effectAllowed = "move";
    draggingDelivery.current = true;
  }

  function isDeliveryDrag(e: DragEvent) {
    return draggingDelivery.current || [...e.dataTransfer.types].includes(DELIVERY_MIME);
  }

  function dropDeliveryOnColumn(col: Date) {
    if (!canManageWork) return;
    proposeDelivery(deliveryDueOnColumn(col, zoom, data?.project.delivery_on || null));
  }

  function selectedDepTasks(): PlanTask[] {
    const ids = new Set(draft.predecessor_ids);
    return (data?.tasks || []).filter((task) => ids.has(task.id));
  }

  function openDepartment(id: string) {
    if (!id || focusDepartmentId || !projectId) return;
    navigate(`/org/projects/${projectId}/departments/${id}`);
  }

  function openNew(departmentId: string | null, col: Date, assigneeUserId?: string | null) {
    if (!canManageDept(departmentId) || pickingDeps) return;
    setTaskMenu(null);
    setTitleFocusGen((n) => n + 1);
    setEditing("new");
    setDraft({
      title: "",
      notes: "",
      department_id: departmentId || "",
      assignee_user_id: assigneeUserId || "",
      due_on: newTaskDueOn(col, zoom),
      notify_days: "",
      predecessor_ids: [],
    });
  }

  function openEdit(task: PlanTask) {
    if (pickingDeps) {
      togglePickedDep(task.id);
      return;
    }
    if (editing === "new" || !editing || editing.id !== task.id) {
      setTitleFocusGen((n) => n + 1);
    }
    setTaskMenu(null);
    setSubtaskDraft({ title: "", assignee_user_id: "" });
    setEditing(task);
    setDraft({
      title: task.title,
      notes: task.notes || "",
      department_id: task.department_id || "",
      assignee_user_id: task.assignee_user_id || "",
      due_on: taskDueOn(task),
      notify_days: notifyDaysInput(task.notify_days_before),
      predecessor_ids: task.predecessor_ids,
    });
  }

  async function saveTask(e: FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    const title = draft.title.trim();
    if (!title) return;
    const parsedNotify = parseNotifyDays(draft.notify_days);
    if (parsedNotify === "invalid") {
      setError("Notify days must be 0–365, or empty to turn off.");
      return;
    }
    const body = {
      title,
      notes: draft.notes.trim() || null,
      department_id: draft.department_id || null,
      assignee_user_id: draft.assignee_user_id || null,
      due_on: draft.due_on,
      notify_days_before: parsedNotify,
      predecessor_ids: draft.predecessor_ids,
    };
    if (editing && editing !== "new") {
      const offsetDays = dayDelta(taskDueOn(editing), draft.due_on);
      const all = data?.tasks || [];
      const upstream = undoneBlockingTasks(editing, all);
      const following = undoneFollowingTasks(editing, all);
      const apply = async (answers: { upstream: boolean; following: boolean }) => {
        if (offsetDays) {
          await api.reschedulePlanTask(editing.id, {
            due_on: draft.due_on,
            department_id: body.department_id,
            shift_upstream: answers.upstream,
            shift_following: answers.following,
          });
          await api.updatePlanTask(editing.id, {
            title: body.title,
            notes: body.notes,
            assignee_user_id: body.assignee_user_id,
            notify_days_before: body.notify_days_before,
            predecessor_ids: body.predecessor_ids,
          });
        } else {
          await api.updatePlanTask(editing.id, body);
        }
        closeEditor();
        await load();
      };
      if (
        beginShiftFlow({
          title: editing.title,
          offsetDays,
          upstream,
          following,
          apply,
        })
      ) {
        return;
      }
      setError("");
      try {
        await apply({ upstream: false, following: false });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save task");
      }
      return;
    }
    setError("");
    try {
      const created = await api.createPlanTask(projectId, body);
      await load();
      setEditing(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save task");
    }
  }

  async function toggleTask(task: PlanTask) {
    if (!canToggleTaskStatus(task)) return;
    setError("");
    try {
      await api.updatePlanTask(task.id, { status: task.status === "done" ? "open" : "done" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update task");
    }
  }

  function onTaskContextMenu(e: MouseEvent<HTMLButtonElement>, task: PlanTask) {
    setDeptMenu(null);
    selection.onChipContextMenu(task.id);
    openConnectedMenu(e, task);
  }

  async function addSubtask(parent: PlanTask) {
    if (!projectId || parent.parent_id || !canManageTask(parent)) return;
    setError("");
    try {
      await api.createPlanTask(projectId, {
        title: "New subtask",
        parent_id: parent.id,
        department_id: parent.department_id,
        due_on: taskDueOn(parent),
      });
      openEdit(parent);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add subtask");
    }
  }

  async function submitSubtask() {
    if (!projectId || !editing || editing === "new" || editing.parent_id) return;
    const title = subtaskDraft.title.trim();
    if (!title) return;
    setError("");
    try {
      await api.createPlanTask(projectId, {
        title,
        parent_id: editing.id,
        department_id: editing.department_id,
        due_on: taskDueOn(editing),
        assignee_user_id: subtaskDraft.assignee_user_id || null,
      });
      setSubtaskDraft({ title: "", assignee_user_id: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add subtask");
    }
  }

  async function toggleSubtask(child: PlanSubtask) {
    if (child.status !== "done" && !child.can_complete) return;
    setError("");
    try {
      await api.updatePlanTask(child.id, { status: child.status === "done" ? "open" : "done" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update subtask");
    }
  }

  async function removeTask(task: PlanTask) {
    if (!confirm(`Delete “${task.title}”?`)) return;
    setError("");
    try {
      await api.deletePlanTask(task.id);
      closeEditor();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete task");
    }
  }

  async function attachToTask(task: PlanTask, files: File[]) {
    if (!files.length || !canManageTask(task)) return;
    setError("");
    setAttachBusy(true);
    try {
      let latest = task;
      for (const file of files) {
        latest = await api.addPlanTaskAttachment(task.id, file);
      }
      setEditing(latest);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach file");
    } finally {
      setAttachBusy(false);
    }
  }

  async function detachFromTask(task: PlanTask, attachmentId: string) {
    if (!canManageTask(task)) return;
    setError("");
    try {
      const latest = await api.deletePlanTaskAttachment(task.id, attachmentId);
      setEditing(latest);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove file");
    }
  }

  function onTaskDragStart(e: DragEvent, task: PlanTask) {
    if (!canManageTask(task) || pickingDeps || selection.consumeDragStart()) {
      e.preventDefault();
      return;
    }
    const multi = selection.selectedIds.has(task.id) && selection.selectedIds.size > 1;
    const ids = multi ? [...selection.selectedIds] : [task.id];
    if (!selection.selectedIds.has(task.id)) selection.onChipContextMenu(task.id);
    e.dataTransfer.setData(TASK_MIME, task.id);
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    draggingId.current = task.id;
    const nextMove = { grabbedId: task.id, ids };
    dragMoveRef.current = nextMove;
    setDragMove(nextMove);
    if (ids.length > 1 && e.currentTarget instanceof HTMLElement) {
      setCountDragImage(e.dataTransfer, e.currentTarget, ids.length - 1);
    }
  }

  function clearDragUi() {
    draggingId.current = null;
    draggingDelivery.current = false;
    dragMoveRef.current = null;
    setDragMove(null);
    setHoverCol(null);
    setDropKey(null);
    setDropChipId(null);
  }

  async function applySetMove(
    grabbed: PlanTask,
    ids: string[],
    col: Date,
    answers: { upstream: boolean; following: boolean },
  ) {
    const all = data?.tasks || [];
    const movingIds = new Set(ids);
    const selected = ids
      .map((id) => all.find((row) => row.id === id))
      .filter((row): row is PlanTask => Boolean(row));
    const delta = planColumnDelta(taskDueOn(grabbed), col, zoom);
    const offsetDays = dayDelta(taskDueOn(grabbed), dropDueOn(taskDueOn(grabbed), col, zoom));
    const { upstream, following } = relatedUnion(selected, all, canManageTask);
    selected.sort((a, b) => {
      const destA = shiftDueByColumns(taskDueOn(a), delta, zoom);
      const destB = shiftDueByColumns(taskDueOn(b), delta, zoom);
      return (
        projectTaskColumnKey(destA, zoom).localeCompare(projectTaskColumnKey(destB, zoom)) ||
        a.sort_order - b.sort_order ||
        a.id.localeCompare(b.id)
      );
    });
    for (const task of selected) {
      const dueOn = shiftDueByColumns(taskDueOn(task), delta, zoom);
      const destColumn = projectTaskColumnKey(dueOn, zoom);
      const beforeId = cellAppendBlockBeforeId({
        items: all,
        movingIds,
        departmentId: task.department_id,
        destColumn,
        idOf: (row) => row.id,
        deptOf: (row) => row.department_id,
        sortOf: (row) => row.sort_order,
        columnOf: (row) => projectTaskColumnKey(taskDueOn(row), zoom),
        assigneeOf: focusDepartmentId ? (row) => row.assignee_user_id : undefined,
        assigneeUserId: focusDepartmentId ? task.assignee_user_id ?? null : undefined,
      });
      await api.reschedulePlanTask(task.id, {
        due_on: dueOn,
        department_id: task.department_id,
        before_id: beforeId,
      });
    }
    if (answers.upstream || answers.following) {
      const extraIds = new Set<string>();
      if (answers.upstream) for (const row of upstream) extraIds.add(row.id);
      if (answers.following) for (const row of following) extraIds.add(row.id);
      for (const id of extraIds) {
        const extra = all.find((row) => row.id === id);
        if (!extra) continue;
        await api.reschedulePlanTask(id, {
          due_on: ymd(addDays(parseYmd(taskDueOn(extra)), offsetDays)),
        });
      }
    }
    await load();
  }

  async function onCellDrop(
    e: DragEvent,
    departmentId: string | null,
    col: Date,
    beforeId?: string,
    assigneeUserId?: string | null,
  ) {
    e.preventDefault();
    if (isDeliveryDrag(e)) {
      clearDragUi();
      dropDeliveryOnColumn(col);
      return;
    }
    const id = e.dataTransfer.getData(TASK_MIME) || draggingId.current;
    const move = dragMoveRef.current;
    clearDragUi();
    if (!id || pickingDeps || shiftPrompt || deliveryPrompt) return;
    if (beforeId && beforeId === id && !(move && move.ids.length > 1)) return;
    const task = data?.tasks.find((row) => row.id === id);
    if (!task || !canManageTask(task)) return;
    const setIds = move && move.grabbedId === id && move.ids.length > 1 ? move.ids : null;
    if (setIds) {
      const delta = planColumnDelta(taskDueOn(task), col, zoom);
      if (!delta) return;
      const all = data?.tasks || [];
      const selected = setIds
        .map((taskId) => all.find((row) => row.id === taskId))
        .filter((row): row is PlanTask => Boolean(row));
      const { upstream, following } = relatedUnion(selected, all, canManageTask);
      const offsetDays = dayDelta(taskDueOn(task), dropDueOn(taskDueOn(task), col, zoom));
      const apply = (answers: { upstream: boolean; following: boolean }) => applySetMove(task, setIds, col, answers);
      if (
        beginShiftFlow({
          title: `${selected.length} tasks`,
          offsetDays,
          upstream,
          following,
          apply,
        })
      ) {
        return;
      }
      setError("");
      try {
        await apply({ upstream: false, following: false });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not move tasks");
        await load();
      }
      return;
    }
    if (!canManageDept(departmentId)) return;
    const dueOn = dropDueOn(taskDueOn(task), col, zoom);
    const offsetDays = dayDelta(taskDueOn(task), dueOn);
    const all = data?.tasks || [];
    const insertBefore = cellInsertBeforeId({
      items: all,
      draggedId: id,
      departmentId,
      column: projectColumnKey(col, zoom),
      dropOnId: beforeId || null,
      idOf: (row) => row.id,
      deptOf: (row) => row.department_id,
      sortOf: (row) => row.sort_order,
      columnOf: (row) => projectTaskColumnKey(taskDueOn(row), zoom),
      assigneeOf: focusDepartmentId ? (row) => row.assignee_user_id : undefined,
      assigneeUserId: focusDepartmentId ? assigneeUserId ?? null : undefined,
    });
    const upstream = undoneBlockingTasks(task, all);
    const following = undoneFollowingTasks(task, all);
    const apply = async (answers: { upstream: boolean; following: boolean }) => {
      await api.reschedulePlanTask(id, {
        due_on: dueOn,
        department_id: departmentId,
        before_id: insertBefore,
        shift_upstream: answers.upstream,
        shift_following: answers.following,
      });
      if (focusDepartmentId && (task.assignee_user_id || null) !== (assigneeUserId ?? null)) {
        await api.updatePlanTask(id, { assignee_user_id: assigneeUserId ?? null });
      }
      await load();
    };
    if (
      beginShiftFlow({
        title: task.title,
        offsetDays,
        upstream,
        following,
        apply,
      })
    ) {
      return;
    }
    setError("");
    try {
      await apply({ upstream: false, following: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move task");
    }
  }

  const focusDept = focusDepartmentId
    ? (data?.departments ?? []).find((dept) => dept.id === focusDepartmentId) ?? null
    : null;
  const focusMissing = Boolean(data && focusDepartmentId && !focusDept);
  const focusTasks = (data?.tasks ?? []).filter((task) => {
    if (!focusDepartmentId || task.parent_id || task.department_id !== focusDepartmentId) return false;
    if (hideDone && task.status === "done") return false;
    return true;
  });
  const rows: PlanGridRow[] = focusDepartmentId
    ? focusDept
      ? departmentFocusRows(focusDept, focusTasks, data?.members ?? [])
      : []
    : departmentBoardRows(data?.departments ?? [], true);
  const todayLabel = zoom === "day" ? "Today" : zoom === "month" ? "This month" : "This week";
  const showBars = planView === "bars" && !pickingDeps && !connected;
  const showProjects = planView === "projects" && !pickingDeps && !connected;
  const hiddenConnected = connected ? hiddenConnectedCount(connected, paintedIds) : 0;
  const destDropKeys = useMemo(() => {
    if (!dragMove || dragMove.ids.length < 2 || !hoverCol || !data) return null;
    const grabbed = data.tasks.find((row) => row.id === dragMove.grabbedId);
    if (!grabbed) return null;
    const delta = planColumnDelta(taskDueOn(grabbed), hoverCol, zoom);
    const keys = new Set<string>();
    for (const id of dragMove.ids) {
      const task = data.tasks.find((row) => row.id === id);
      if (!task || task.parent_id) continue;
      const dest = shiftDueByColumns(taskDueOn(task), delta, zoom);
      const rowKey = focusDepartmentId ? task.assignee_user_id || "dept" : task.department_id || "none";
      keys.add(`${rowKey}|${projectTaskColumnKey(dest, zoom)}`);
    }
    return keys;
  }, [dragMove, hoverCol, data, zoom, focusDepartmentId]);

  return (
    <div className="shell">
      <OrgSidebar active="project" />
      <main className="main plan">
        <div className="main-head plan-toolbar">
          <div>
            <Link className="hint plan-back" to={focusDepartmentId ? `/org/projects/${projectId}` : "/org"}>
              ←{" "}
              {focusDepartmentId ? (
                <span>Project</span>
              ) : (
                <>
                  <span className="plan-back-full">Organization</span>
                  <span className="plan-back-short">Org</span>
                </>
              )}
            </Link>
            {admin && data ? (
              <input
                className="plan-title-input"
                value={projectName}
                maxLength={120}
                aria-label="Project name"
                onChange={(e) => setProjectName(e.target.value)}
                onBlur={() => void commitProjectName()}
              />
            ) : (
              <h1>{data?.project.name || "Project"}</h1>
            )}
            {focusDept ? (
              <p className="hint" style={{ margin: "4px 0 0" }}>
                {focusDept.name}
              </p>
            ) : null}
          </div>
          <div className="composer-row">
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
            <PlanViewSwitch mode={planView} onChange={setPlanView} />
            <label className="toggle">
              <input
                type="checkbox"
                checked={hideDone}
                onChange={(e) => {
                  const next = e.target.checked;
                  setHideDone(next);
                  if (projectId) writeHideDone(projectId, next);
                }}
              />
              Hide done
            </label>
            {data?.project.delivery_on ? (
              <div className="plan-zoom" role="group" aria-label="Headers">
                <button
                  className={`btn ghost small${headerMode === "calendar" ? " on" : ""}`}
                  type="button"
                  onClick={() => changeHeaderMode("calendar")}
                >
                  Calendar
                </button>
                <button
                  className={`btn ghost small${headerMode === "relative" ? " on" : ""}`}
                  type="button"
                  onClick={() => changeHeaderMode("relative")}
                >
                  Relative
                </button>
              </div>
            ) : null}
            {canManageWork ? (
              <label className="plan-delivery-field">
                Delivery
                <input
                  type="date"
                  value={deliveryDraft}
                  aria-label="Delivery date"
                  onChange={(e) => setDeliveryDraft(e.target.value)}
                  onBlur={() => commitDeliveryField()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === "Escape") {
                      setDeliveryDraft(data?.project.delivery_on || "");
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
              </label>
            ) : null}
            {canManageWork && !data?.project.delivery_on ? (
              <button
                className="btn ghost small"
                type="button"
                draggable
                onDragStart={onDeliveryDragStart}
                onDragEnd={() => {
                  draggingDelivery.current = false;
                  setHoverCol(null);
                }}
              >
                Add delivery
              </button>
            ) : null}
            <button className="btn ghost small" type="button" onClick={() => scrollPlanHeader(".plan-week.current")}>
              {todayLabel}
            </button>
            {previewDelivery ? (
              <button
                className="btn ghost small"
                type="button"
                onClick={() =>
                  scrollPlanHeader(`[data-plan-col="${projectColumnKey(parseYmd(previewDelivery), zoom)}"]`)
                }
              >
                Delivery
              </button>
            ) : null}
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {shiftPrompt ? (
          <ShiftRelatedDialog
            prompt={shiftPrompt}
            busy={shiftBusy}
            onResolve={(move) =>
              void resolveShiftPrompt(move, (message) => {
                setError(message);
                void load();
              })
            }
          />
        ) : null}
        {deliveryPrompt ? (
          <DeliveryMoveDialog
            prompt={deliveryPrompt}
            busy={deliveryBusy}
            onMoveAll={() => void applyDelivery(deliveryPrompt.next, true)}
            onMarkOnly={() => void applyDelivery(deliveryPrompt.next, false)}
            onCancel={cancelDeliveryMove}
          />
        ) : null}
        {focusMissing ? <p className="error">That department is not on this project.</p> : null}
        {connected ? <ShowConnectedBanner hiddenCount={hiddenConnected} onDismiss={hideConnected} /> : null}
        {!data ? (
          <p className="hint">Loading…</p>
        ) : focusMissing ? null : (
          <div
            ref={gridWrapRef}
            className={`plan-grid-wrap${pickingDeps ? " picking-deps" : ""}${connected ? " showing-connected" : ""}${selection.selecting ? " plan-selecting" : ""}`}
            onClick={(e) => {
              if (selection.onWrapClick(e)) return;
              if (connected) connectedGridClick(e, hideConnected);
            }}
            style={
              focusDepartmentId && whoColumn.width != null
                ? { ["--plan-dept-col" as string]: `${whoColumn.width}px` }
                : undefined
            }
          >
            <div
              className={`plan-grid${showProjects ? " plan-spans" : ""}`}
              style={{
                ["--weeks" as string]: columns.length,
                ["--plan-col-min" as string]: zoom === "day" ? "108px" : "148px",
              }}
            >
              <div className="plan-corner">
                <span className="plan-corner-label">{focusDepartmentId ? "Who" : "Department"}</span>
                {focusDepartmentId ? (
                  <PlanWhoResizeHandle width={whoColumn.width} onCommit={whoColumn.commit} onReset={whoColumn.reset} />
                ) : null}
              </div>
              {columns.map((col, index) => {
                const meta = formatStackedProjectHeader(
                  col,
                  zoom,
                  index > 0 ? columns[index - 1] : null,
                  headerMode === "relative" && Boolean(previewDelivery),
                  previewDelivery,
                );
                const deliveryHere = isDeliveryPlanColumn(col, previewDelivery, zoom);
                const deliveryPreview = Boolean(deliveryPrompt) && deliveryHere;
                return (
                  <div
                    className={`plan-week${isCurrentPlanColumn(col, zoom) ? " current" : ""}${deliveryHere ? " delivery" : ""}${deliveryPreview ? " delivery-preview" : ""}`}
                    data-plan-col={projectColumnKey(col, zoom)}
                    key={projectColumnKey(col, zoom)}
                    onDragOver={(e) => {
                      if (!canManageWork || !isDeliveryDrag(e)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setHoverCol(col);
                    }}
                    onDrop={(e) => {
                      if (!isDeliveryDrag(e)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      draggingDelivery.current = false;
                      dropDeliveryOnColumn(col);
                    }}
                  >
                    <div className="plan-week-head">
                      <strong
                        className={deliveryHere && canManageWork ? "plan-delivery-handle" : undefined}
                        draggable={Boolean(deliveryHere && canManageWork && data?.project.delivery_on)}
                        onDragStart={onDeliveryDragStart}
                        onDragEnd={() => {
                          draggingDelivery.current = false;
                          setHoverCol(null);
                        }}
                      >
                        {meta.title}
                      </strong>
                      {meta.year ? <span className="plan-year">{meta.year}</span> : null}
                    </div>
                    {meta.sub ? <span className="hint">{meta.sub}</span> : null}
                  </div>
                );
              })}
              {rows.map((row, rowIndex) => {
                const rowManage = canManageDept(row.departmentId);
                const gridRow = rowIndex + 2;
                return [
                  <div
                    className={`plan-dept${row.person ? " plan-person" : ""}${row.navigable ? " plan-dept-open" : ""}`}
                    key={`d-${row.key}`}
                    style={{
                      ...(showProjects ? { gridRow, gridColumn: 1 } : null),
                      background: `color-mix(in srgb, ${row.color} ${row.person ? "16%" : "35%"}, var(--bg-raised))`,
                    }}
                    title={row.navigable ? "Open department" : undefined}
                    onDoubleClick={() => {
                      if (row.navigable && row.departmentId) openDepartment(row.departmentId);
                    }}
                    onContextMenu={(e) => {
                      if (!row.navigable || !row.departmentId) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setTaskMenu(null);
                      setDeptMenu({ id: row.departmentId, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="dot" style={{ background: row.color }} />
                    <span className="plan-dept-name">{row.name}</span>
                  </div>,
                  ...columns.map((col, colIndex) => {
                    const key = cellKey(row.key, col);
                    const tasks = tasksByCell.get(key) || [];
                    return (
                      <div
                        className={`plan-cell${showBars || showProjects ? "" : destDropKeys?.has(key) || (dropKey === key && !destDropKeys) ? " drag-over" : ""}${isCurrentPlanColumn(col, zoom) ? " current" : ""}`}
                        key={key}
                        style={showProjects ? { gridRow, gridColumn: colIndex + 2 } : undefined}
                        onPointerDown={
                          showBars || showProjects ? undefined : (e) => selection.onCellPointerDown(e)
                        }
                        onDragOver={
                          showBars || showProjects
                            ? undefined
                            : (e) => {
                                if (isDeliveryDrag(e)) {
                                  if (!canManageWork || pickingDeps) return;
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = "move";
                                  setHoverCol(col);
                                  setDropKey(key);
                                  setDropChipId(null);
                                  return;
                                }
                                const multi = Boolean(dragMoveRef.current && dragMoveRef.current.ids.length > 1);
                                if (!multi && (!rowManage || pickingDeps)) return;
                                if (pickingDeps) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                                setHoverCol(col);
                                if (multi) {
                                  setDropKey(null);
                                  setDropChipId(null);
                                  return;
                                }
                                setDropKey(key);
                                setDropChipId(null);
                              }
                        }
                        onDragLeave={
                          showBars || showProjects
                            ? undefined
                            : () => setDropKey((cur) => (cur === key ? null : cur))
                        }
                        onDrop={
                          showBars || showProjects
                            ? undefined
                            : (e) => void onCellDrop(e, row.departmentId, col, undefined, row.assigneeUserId)
                        }
                        onDoubleClick={
                          showBars || showProjects
                            ? undefined
                            : () => {
                                if (!pickingDeps) openNew(row.departmentId, col, row.assigneeUserId);
                              }
                        }
                      >
                        {showBars ? (
                          <PlanWorkloadBar count={tasks.length} />
                        ) : showProjects ? null : (
                          <>
                        {tasks.map((task) => (
                          <button
                            key={task.id}
                            type="button"
                            data-plan-chip-id={task.id}
                            className={`plan-chip${task.status === "done" ? " done" : ""}${task.blocked ? " blocked" : ""}${selection.isSelected(task.id) ? " selected" : ""}${pickingDeps && draft.predecessor_ids.includes(task.id) ? " dep-picked" : ""}${pickingDeps && task.id === editingTaskId() ? " dep-source" : ""}${dropChipId === task.id ? " drop-before" : ""}${connectedChipClass(task.id, connected)}`}
                            style={
                              task.status === "done"
                                ? undefined
                                : { background: `color-mix(in srgb, ${row.color} 28%, var(--bg-card))` }
                            }
                            draggable={canManageTask(task) && !pickingDeps}
                            onPointerDown={(e) => selection.onChipPointerDown(e)}
                            onDragStart={(e) => onTaskDragStart(e, task)}
                            onDragEnd={() => clearDragUi()}
                            onDragOver={(e) => {
                              const multi = Boolean(dragMoveRef.current && dragMoveRef.current.ids.length > 1);
                              if (pickingDeps) return;
                              if (!multi && !rowManage) return;
                              if (draggingId.current === task.id) return;
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
                              setHoverCol(col);
                              if (multi) {
                                setDropChipId(null);
                                setDropKey(null);
                                return;
                              }
                              setDropChipId(task.id);
                              setDropKey(null);
                            }}
                            onDragLeave={(e) => {
                              const next = e.relatedTarget as Node | null;
                              if (next && e.currentTarget.contains(next)) return;
                              setDropChipId((cur) => (cur === task.id ? null : cur));
                            }}
                            onDrop={(e) => {
                              e.stopPropagation();
                              void onCellDrop(e, row.departmentId, col, task.id, row.assigneeUserId);
                            }}
                            onClick={(e) => {
                              const next = selection.onChipClick(e, task.id);
                              if (next.open) openEdit(task);
                            }}
                            onContextMenu={(e) => onTaskContextMenu(e, task)}
                          >
                            <span className="plan-chip-top">
                              <span className="plan-chip-who">
                                {task.assignee ? memberLabel({ user: task.assignee, user_id: task.assignee.id } as Membership) : "Dept"}
                              </span>
                              {task.progress != null ? <ProgressBadge percent={task.progress} /> : null}
                            </span>
                            <span className="plan-chip-title">{task.title}</span>
                            {task.blocked ? <span className="hint">Waiting</span> : null}
                          </button>
                        ))}
                        {rowManage && !pickingDeps ? (
                          <button className="plan-add" type="button" onClick={() => openNew(row.departmentId, col, row.assigneeUserId)}>
                            +
                          </button>
                        ) : null}
                          </>
                        )}
                      </div>
                    );
                  }),
                  showProjects ? (
                    <PlanProjectSpans
                      key={`spans-${row.key}`}
                      spans={spansByRow.get(row.key) ?? []}
                      columnCount={columns.length}
                      gridRow={gridRow}
                    />
                  ) : null,
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

        {editing ? (
          <PlanTaskEditor
            editing={editing}
            pickingDeps={pickingDeps}
            titleFocusGen={titleFocusGen}
            draft={draft}
            onDraftChange={setDraft}
            canEdit={editing === "new" ? canManageDept(draft.department_id || null) : canManageTask(editing)}
            departments={
              canManageWork
                ? data?.departments ?? []
                : (data?.departments ?? []).filter((dept) => leadIds.includes(dept.id) || dept.id === draft.department_id)
            }
            allowUnassigned={canManageWork}
            members={data?.members ?? []}
            departmentMemberIds={data?.departments.find((dept) => dept.id === draft.department_id)?.member_ids ?? []}
            selectedDeps={selectedDepTasks().map((task) => ({ id: task.id, title: task.title }))}
            attachBusy={attachBusy}
            subtaskDraft={subtaskDraft}
            onSubtaskDraftChange={setSubtaskDraft}
            onSave={(e) => void saveTask(e)}
            onClose={closeEditor}
            onToggleStatus={() => {
              if (editing !== "new") void toggleTask(editing);
            }}
            onDelete={() => {
              if (editing !== "new") void removeTask(editing);
            }}
            onStartPickingDeps={startPickingDeps}
            onConfirmPickedDeps={confirmPickedDeps}
            onCancelPickedDeps={cancelPickedDeps}
            onOpenAttachment={(att) => setLightbox(lightboxFor(att))}
            onAttach={(files) => {
              if (editing !== "new") void attachToTask(editing, files);
            }}
            onDetach={(attachmentId) => {
              if (editing !== "new") void detachFromTask(editing, attachmentId);
            }}
            onOpenSubtask={(child) => {
              const full = data?.tasks.find((row) => row.id === child.id);
              if (full) openEdit(full);
            }}
            onToggleSubtask={(child) => void toggleSubtask(child)}
            onSubmitSubtask={() => void submitSubtask()}
          />
        ) : null}
        {lightbox ? <LightboxOverlay lightbox={lightbox} onClose={() => setLightbox(null)} /> : null}
        <DepartmentViewMenu menu={deptMenu} onOpen={openDepartment} onClose={() => setDeptMenu(null)} />
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
            {canManageTask(taskMenu.task) && !taskMenu.task.parent_id ? (
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
            {canToggleTaskStatus(taskMenu.task) ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const task = taskMenu.task;
                setTaskMenu(null);
                void toggleTask(task);
              }}
            >
              {taskMenu.task.status === "done" ? "Reopen" : "Mark done"}
            </button>
            ) : null}
            <ShowConnectedMenuItem
              isSource={connected?.sourceId === taskMenu.task.id}
              chain={taskMenu.chain}
              onShow={beginShowConnected}
              onHide={() => {
                hideConnected();
                closeTaskMenu();
              }}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
