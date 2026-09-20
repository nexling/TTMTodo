import { type DragEvent, type FormEvent, type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Attachment, type Membership, type PlanBoard as PlanBoardData, type PlanSubtask, type PlanTask } from "../api";
import { PlanAssigneeSelect, memberLabel } from "../components/PlanAssigneeSelect";
import OrgSidebar from "../components/OrgSidebar";
import PlanEditorResizeHandle from "../components/PlanEditorResizeHandle";
import {
  AttachmentBlock,
  FILE_ACCEPT,
  LightboxOverlay,
  lightboxFor,
  type Lightbox,
} from "../components/ItemCard";
import { ShiftRelatedDialog, useShiftFlow } from "../components/ShiftRelatedDialog";
import { cellInsertBeforeId } from "../planOrder";
import { useLiveReload } from "../live";
import {
  ZOOM_OPTIONS,
  dayDelta,
  dropDueOn,
  formatProjectHeader,
  newTaskDueOn,
  projectColumnKey,
  projectColumnsSpanning,
  projectTaskColumnKey,
  readZoom,
  taskDueOn,
  isCurrentPlanColumn,
  writeZoom,
  ymd,
  type PlanZoom,
} from "../planZoom";

const TASK_MIME = "application/x-magictodo-plan-task";
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

export default function PlanBoard() {
  const { projectId } = useParams();
  const [data, setData] = useState<PlanBoardData | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<PlanZoom>(() => readZoom(ZOOM_KEY));
  const [editing, setEditing] = useState<PlanTask | "new" | null>(null);
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
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const scrolledKey = useRef<string | null>(null);
  const [pickingDeps, setPickingDeps] = useState(false);
  const pickSnapshot = useRef<string[]>([]);
  const { shiftPrompt, shiftBusy, beginShiftFlow, resolveShiftPrompt } = useShiftFlow();
  const [projectName, setProjectName] = useState("");
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [taskMenu, setTaskMenu] = useState<{ task: PlanTask; x: number; y: number } | null>(null);
  const [hideDone, setHideDone] = useState(() => readHideDone(projectId));
  const [subtaskDraft, setSubtaskDraft] = useState({ title: "", assignee_user_id: "" });
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

  const columns = useMemo(() => {
    const dates: string[] = [];
    for (const task of data?.tasks ?? []) {
      if (task.parent_id) continue;
      if (hideDone && task.status === "done") continue;
      dates.push(taskDueOn(task));
    }
    return projectColumnsSpanning(dates, zoom);
  }, [data, zoom, hideDone]);

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
      const key = `${task.department_id || "none"}|${projectTaskColumnKey(taskDueOn(task), zoom)}`;
      const list = map.get(key) || [];
      list.push(task);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [data, zoom, hideDone]);

  function cellKey(departmentId: string | null, col: Date): string {
    return `${departmentId || "none"}|${projectColumnKey(col, zoom)}`;
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
    pickSnapshot.current = draft.predecessor_ids;
    setPickingDeps(true);
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

  function selectedDepTasks(): PlanTask[] {
    const ids = new Set(draft.predecessor_ids);
    return (data?.tasks || []).filter((task) => ids.has(task.id));
  }

  function openNew(departmentId: string | null, col: Date) {
    if (!canManageDept(departmentId) || pickingDeps) return;
    setTaskMenu(null);
    setEditing("new");
    setDraft({
      title: "",
      notes: "",
      department_id: departmentId || "",
      assignee_user_id: "",
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
    if (pickingDeps) return;
    if (!canToggleTaskStatus(task) && !canManageTask(task)) return;
    e.preventDefault();
    e.stopPropagation();
    setTaskMenu({ task, x: e.clientX, y: e.clientY });
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
    if (!canManageTask(task) || pickingDeps) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(TASK_MIME, task.id);
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    draggingId.current = task.id;
  }

  async function onCellDrop(e: DragEvent, departmentId: string | null, col: Date, beforeId?: string) {
    e.preventDefault();
    setDropKey(null);
    setDropChipId(null);
    const id = e.dataTransfer.getData(TASK_MIME) || draggingId.current;
    draggingId.current = null;
    if (!id || pickingDeps || shiftPrompt) return;
    if (beforeId && beforeId === id) return;
    const task = data?.tasks.find((row) => row.id === id);
    if (!task || !canManageTask(task) || !canManageDept(departmentId)) return;
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

  const rows = [
    ...(data?.departments ?? []),
    { id: "", name: "Unassigned", color: "#3a3428", member_ids: [] as string[], lead_ids: [] as string[] },
  ];
  const todayLabel = zoom === "day" ? "Today" : zoom === "month" ? "This month" : "This week";

  return (
    <div className="shell">
      <OrgSidebar active="project" />
      <main className="main plan">
        <div className="main-head plan-toolbar">
          <div>
            <Link className="hint plan-back" to="/org">
              ← <span className="plan-back-full">Organization</span>
              <span className="plan-back-short">Org</span>
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
            <button className="btn ghost small" type="button" onClick={() => scrollPlanHeader(".plan-week.current")}>
              {todayLabel}
            </button>
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
        {!data ? (
          <p className="hint">Loading…</p>
        ) : (
          <div ref={gridWrapRef} className={`plan-grid-wrap${pickingDeps ? " picking-deps" : ""}`}>
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
              {columns.map((col, index) => {
                const meta = formatProjectHeader(col, zoom, index > 0 ? columns[index - 1] : null);
                return (
                  <div
                    className={`plan-week${isCurrentPlanColumn(col, zoom) ? " current" : ""}`}
                    key={projectColumnKey(col, zoom)}
                  >
                    <div className="plan-week-head">
                      <strong>{meta.title}</strong>
                      {meta.year ? <span className="plan-year">{meta.year}</span> : null}
                    </div>
                    {meta.sub ? <span className="hint">{meta.sub}</span> : null}
                  </div>
                );
              })}
              {rows.map((dept) => {
                const deptId = dept.id || null;
                const rowManage = canManageDept(deptId);
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
                    const tasks = tasksByCell.get(key) || [];
                    return (
                      <div
                        className={`plan-cell${dropKey === key ? " drag-over" : ""}${isCurrentPlanColumn(col, zoom) ? " current" : ""}`}
                        key={key}
                        onDragOver={(e) => {
                          if (!rowManage || pickingDeps) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          setDropKey(key);
                          setDropChipId(null);
                        }}
                        onDragLeave={() => setDropKey((cur) => (cur === key ? null : cur))}
                        onDrop={(e) => void onCellDrop(e, deptId, col)}
                        onDoubleClick={() => {
                          if (!pickingDeps) openNew(deptId, col);
                        }}
                      >
                        {tasks.map((task) => (
                          <button
                            key={task.id}
                            type="button"
                            className={`plan-chip${task.status === "done" ? " done" : ""}${task.blocked ? " blocked" : ""}${pickingDeps && draft.predecessor_ids.includes(task.id) ? " dep-picked" : ""}${pickingDeps && task.id === editingTaskId() ? " dep-source" : ""}${dropChipId === task.id ? " drop-before" : ""}`}
                            style={
                              task.status === "done"
                                ? undefined
                                : { background: `color-mix(in srgb, ${dept.color} 28%, var(--bg-card))` }
                            }
                            draggable={canManageTask(task) && !pickingDeps}
                            onDragStart={(e) => onTaskDragStart(e, task)}
                            onDragEnd={() => {
                              draggingId.current = null;
                              setDropKey(null);
                              setDropChipId(null);
                            }}
                            onDragOver={(e) => {
                              if (!rowManage || pickingDeps) return;
                              if (draggingId.current === task.id) return;
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
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
                              void onCellDrop(e, deptId, col, task.id);
                            }}
                            onClick={() => openEdit(task)}
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
          </div>
        )}

        {editing ? <PlanEditorResizeHandle /> : null}

        {editing && pickingDeps ? (
          <div className="plan-editor plan-dep-picker">
            <div className="panel">
              <h2>Assign depending tasks</h2>
              <p className="hint">
                Click one or more other tasks on the board. Those become the tasks this one depends on.
              </p>
              <p>
                Selected: {draft.predecessor_ids.length}{" "}
                {draft.predecessor_ids.length === 1 ? "task" : "tasks"}
                {selectedDepTasks().length
                  ? ` — ${selectedDepTasks()
                      .map((task) => task.title)
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
            {(() => {
                const canEdit = editing === "new" ? canManageDept(draft.department_id || null) : canManageTask(editing);
                const isChild = editing !== "new" && Boolean(editing.parent_id);
                const showSubtasks = editing !== "new" && !editing.parent_id;
                const deptOptions = canManageWork
                  ? data?.departments ?? []
                  : (data?.departments ?? []).filter((dept) => leadIds.includes(dept.id) || dept.id === draft.department_id);
                const attachments = editing === "new" ? [] : editing.attachments ?? [];
                const deptMemberIds =
                  data?.departments.find((dept) => dept.id === draft.department_id)?.member_ids ?? [];
                const children = showSubtasks ? editing.subtasks ?? [] : [];
                return (
            <div className={`plan-editor-layout${showSubtasks ? " has-subtasks" : ""}`}>
            <form className="panel" onSubmit={(e) => void saveTask(e)}>
              <div className="plan-editor-head">
                <h2>{editing === "new" ? "New task" : isChild ? "Subtask" : "Task"}</h2>
                <div className="composer-row">
                  {editing !== "new" && (editing.can_complete || editing.status === "done") ? (
                    <button className="btn" type="button" onClick={() => void toggleTask(editing)}>
                      {editing.status === "done" ? "Reopen" : "Mark done"}
                    </button>
                  ) : null}
                  {canEdit ? (
                    <button className="btn" type="submit">
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
              </div>
              <label>
                Title
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={500} disabled={!canEdit} />
              </label>
              <label>
                Notes
                <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={3} disabled={!canEdit} />
              </label>
              {canEdit ? (
                <div className={`plan-editor-row${isChild ? " single" : ""}`}>
                  {isChild ? null : (
                    <label>
                      Department
                      <select
                        value={draft.department_id}
                        onChange={(e) => setDraft({ ...draft, department_id: e.target.value })}
                      >
                        {canManageWork ? <option value="">Unassigned</option> : null}
                        {deptOptions.map((dept) => (
                          <option key={dept.id} value={dept.id}>
                            {dept.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Assigned to
                    <PlanAssigneeSelect
                      value={draft.assignee_user_id}
                      onChange={(userId) => setDraft({ ...draft, assignee_user_id: userId })}
                      members={data?.members ?? []}
                      departmentMemberIds={deptMemberIds}
                    />
                  </label>
                </div>
              ) : null}
              {canEdit && !isChild ? (
                <>
                  <div className="plan-editor-row">
                    <label>
                      Date
                      <input
                        type="date"
                        value={draft.due_on}
                        onChange={(e) => setDraft({ ...draft, due_on: e.target.value })}
                      />
                    </label>
                    <label>
                      Notify days before due
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="off"
                        value={draft.notify_days}
                        aria-label="Days before due to email"
                        onChange={(e) => setDraft({ ...draft, notify_days: e.target.value })}
                      />
                    </label>
                  </div>
                  <p className="hint">Assignee, or department leads if unassigned, get the email.</p>
                </>
              ) : null}
              {canEdit && !isChild ? (
                <div className="plan-editor-row">
                  <div className="plan-dep-field">
                    <span>Depends on</span>
                    {selectedDepTasks().length ? (
                      <ul className="plan-dep-list">
                        {selectedDepTasks().map((task) => (
                          <li key={task.id}>{task.title}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="hint">No depending tasks yet.</p>
                    )}
                    <button className="btn" type="button" onClick={startPickingDeps}>
                      Assign depending tasks
                    </button>
                  </div>
                  {editing !== "new" ? (
                    <div className="plan-dep-field">
                      <span>Attachments</span>
                      {attachments.length ? (
                        <div className="thumbs">
                          {attachments.map((att: Attachment) => (
                            <AttachmentBlock
                              key={att.id}
                              att={att}
                              onOpen={(file) => setLightbox(lightboxFor(file))}
                              onRemove={() => void detachFromTask(editing, att.id)}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="hint">No files yet.</p>
                      )}
                      <label className="btn ghost small file-btn">
                        {attachBusy ? "Adding…" : "Attach"}
                        <input
                          type="file"
                          multiple
                          accept={FILE_ACCEPT}
                          disabled={attachBusy}
                          onChange={(e) => {
                            const chosen = e.target.files;
                            if (chosen?.length) void attachToTask(editing, Array.from(chosen));
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                  ) : (
                    <p className="hint">Save the task to add attachments.</p>
                  )}
                </div>
              ) : editing !== "new" ? (
                <div className="plan-dep-field">
                  <span>Attachments</span>
                  {attachments.length ? (
                    <div className="thumbs">
                      {attachments.map((att: Attachment) => (
                        <AttachmentBlock
                          key={att.id}
                          att={att}
                          onOpen={(file) => setLightbox(lightboxFor(file))}
                          onRemove={canEdit ? () => void detachFromTask(editing, att.id) : undefined}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="hint">No files yet.</p>
                  )}
                  {canEdit ? (
                    <label className="btn ghost small file-btn">
                      {attachBusy ? "Adding…" : "Attach"}
                      <input
                        type="file"
                        multiple
                        accept={FILE_ACCEPT}
                        disabled={attachBusy}
                        onChange={(e) => {
                          const chosen = e.target.files;
                          if (chosen?.length) void attachToTask(editing, Array.from(chosen));
                          e.target.value = "";
                        }}
                      />
                    </label>
                  ) : null}
                </div>
              ) : (
                <p className="hint">Save the task to add attachments.</p>
              )}
            </form>
            {showSubtasks ? (
              <div className="panel plan-subtasks">
                <h2>Subtasks</h2>
                {children.length ? (
                  <ul className="plan-subtask-list">
                    {children.map((child) => (
                      <li key={child.id}>
                        <button
                          type="button"
                          className={`plan-subtask-row${child.status === "done" ? " done" : ""}`}
                          onClick={() => {
                            const full = data?.tasks.find((row) => row.id === child.id);
                            if (full) openEdit(full);
                          }}
                        >
                          <span className="plan-subtask-title">{child.title}</span>
                          <span className="hint">
                            {child.assignee
                              ? memberLabel({ user: child.assignee, user_id: child.assignee.id } as Membership)
                              : "Nobody yet"}
                          </span>
                          <span className="hint">{child.status === "done" ? "Done" : "Open"}</span>
                        </button>
                        {child.status === "done" || child.can_complete ? (
                          <button
                            className="btn ghost small"
                            type="button"
                            onClick={() => void toggleSubtask(child)}
                          >
                            {child.status === "done" ? "Reopen" : "Done"}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">No subtasks yet.</p>
                )}
                {canEdit ? (
                  <div className="plan-subtask-add">
                    <input
                      value={subtaskDraft.title}
                      onChange={(e) => setSubtaskDraft({ ...subtaskDraft, title: e.target.value })}
                      placeholder="Add subtask"
                      maxLength={500}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitSubtask();
                        }
                      }}
                    />
                    <PlanAssigneeSelect
                      value={subtaskDraft.assignee_user_id}
                      onChange={(userId) => setSubtaskDraft({ ...subtaskDraft, assignee_user_id: userId })}
                      members={data?.members ?? []}
                      departmentMemberIds={deptMemberIds}
                    />
                    <button className="btn" type="button" onClick={() => void submitSubtask()}>
                      Add
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            </div>
                );
              })()}
          </div>
        ) : null}
        {lightbox ? <LightboxOverlay lightbox={lightbox} onClose={() => setLightbox(null)} /> : null}
        {taskMenu ? (
          <div
            className="color-menu"
            style={{
              left: Math.max(12, Math.min(taskMenu.x, window.innerWidth - 180)),
              top: Math.max(12, Math.min(taskMenu.y, window.innerHeight - 80)),
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
          </div>
        ) : null}
      </main>
    </div>
  );
}
