import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PlanMyTodos, type PlanSubtask, type PlanTask } from "../api";
import { useLiveReload } from "../live";
import OrgSidebar from "../components/OrgSidebar";
import PlanTaskEditor, { notifyDaysInput, parseNotifyDays } from "../components/PlanTaskEditor";
import { LightboxOverlay, lightboxFor, type Lightbox } from "../components/ItemCard";
import PlanWhoResizeHandle from "../components/PlanWhoResizeHandle";
import { PlanProjectSpans, PlanViewSwitch, PlanWorkloadBar } from "../components/PlanWorkloadBar";
import { memberLabel } from "../components/PlanAssigneeSelect";
import { ShiftRelatedDialog, useShiftFlow } from "../components/ShiftRelatedDialog";
import { useWhoColumnWidth } from "../planWhoWidth";
import { usePlanView } from "../planWorkload";
import { projectSpans } from "../planSpan";
import {
  ZOOM_OPTIONS,
  dayDelta,
  formatChipDay,
  formatProjectHeader,
  isCurrentPlanColumn,
  projectColumnKey,
  projectColumnsSpanning,
  projectTaskColumnKey,
  readZoom,
  taskDueOn,
  writeZoom,
  ymd,
  type PlanZoom,
} from "../planZoom";

const ZOOM_KEY = "magictodo:plan-zoom:my-todos";
const ROW_COLOR = "#3a3428";

type TodoScope = "mine" | "people" | "department";

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

function personName(data: PlanMyTodos | null, userId: string, task?: PlanTask): string {
  const member = data?.members.find((row) => row.user_id === userId);
  if (member?.user) return memberLabel(member);
  return task?.assignee?.name || task?.assignee?.email || task?.assignee?.username || "Person";
}

export default function MyOrgTodos() {
  const whoColumn = useWhoColumnWidth();
  const [planView, setPlanView] = usePlanView();
  const [scope, setScope] = useState<TodoScope>("mine");
  const [data, setData] = useState<PlanMyTodos | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<PlanZoom>(() => readZoom(ZOOM_KEY));
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const scrolledKey = useRef<string | null>(null);
  const [editing, setEditing] = useState<PlanTask | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    notes: "",
    department_id: "",
    assignee_user_id: "",
    due_on: ymd(new Date()),
    notify_days: "",
    predecessor_ids: [] as string[],
  });
  const [subtaskDraft, setSubtaskDraft] = useState({ title: "", assignee_user_id: "" });
  const [pickingDeps, setPickingDeps] = useState(false);
  const pickSnapshot = useRef<string[]>([]);
  const { shiftPrompt, shiftBusy, beginShiftFlow, resolveShiftPrompt } = useShiftFlow();
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const leadIds = data?.lead_department_ids ?? [];
  const canSeePeople = Boolean(data?.capabilities.can_manage_project_work || data?.capabilities.can_manage_plan);
  const canManageWork = canSeePeople;

  function canManageDept(departmentId: string | null | undefined): boolean {
    if (canManageWork) return true;
    if (!departmentId) return false;
    return leadIds.includes(departmentId);
  }

  function canManageTask(task: PlanTask): boolean {
    return Boolean(task.can_manage) || canManageDept(task.department_id);
  }

  async function load() {
    setError("");
    try {
      const next = await api.myTodos(scope);
      setData(next);
      setEditing((cur) => {
        if (!cur) return cur;
        return next.tasks.find((task) => task.id === cur.id) ?? cur;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load My Org Todo's");
      setData(null);
    }
  }

  useEffect(() => {
    void load();
  }, [scope]);

  useLiveReload(
    (event) => event.channel === "plan",
    () => load(),
  );

  const columns = useMemo(() => {
    const dates: string[] = [];
    for (const task of data?.tasks ?? []) dates.push(taskDueOn(task));
    return projectColumnsSpanning(dates, zoom);
  }, [data, zoom]);

  useLayoutEffect(() => {
    const key = `${scope}:${zoom}`;
    if (scrolledKey.current === key) return;
    if (!gridWrapRef.current) return;
    scrolledKey.current = key;
    if (columns.some((col) => isCurrentPlanColumn(col, zoom))) {
      scrollPlanHeader(".plan-week.current");
    }
  }, [scope, zoom, columns]);

  const tasksByCell = useMemo(() => {
    const map = new Map<string, PlanTask[]>();
    for (const task of data?.tasks ?? []) {
      if (!task.assignee_user_id) continue;
      const key = `${task.assignee_user_id}|${projectTaskColumnKey(taskDueOn(task), zoom)}`;
      const list = map.get(key) || [];
      list.push(task);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
    return map;
  }, [data, zoom]);

  const columnKeys = useMemo(() => columns.map((col) => projectColumnKey(col, zoom)), [columns, zoom]);

  const spansByRow = useMemo(() => {
    const grouped = new Map<string, PlanTask[]>();
    for (const task of data?.tasks ?? []) {
      if (!task.assignee_user_id) continue;
      const list = grouped.get(task.assignee_user_id) || [];
      list.push(task);
      grouped.set(task.assignee_user_id, list);
    }
    const map = new Map<string, ReturnType<typeof projectSpans>>();
    for (const [rowKey, tasks] of grouped) {
      map.set(rowKey, projectSpans(tasks, columnKeys, (due) => projectTaskColumnKey(due, zoom), "Project"));
    }
    return map;
  }, [data, zoom, columnKeys]);

  const rows = useMemo(() => {
    const names = new Map<string, string>();
    if (scope === "mine" && data?.viewer_id) {
      names.set(data.viewer_id, personName(data, data.viewer_id));
    }
    for (const task of data?.tasks ?? []) {
      const userId = task.assignee_user_id;
      if (!userId || names.has(userId)) continue;
      if (scope === "mine" && userId !== data?.viewer_id) continue;
      names.set(userId, personName(data, userId, task));
    }
    return [...names.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }) || a[0].localeCompare(b[0]))
      .map(([key, name]) => ({ key, name }));
  }, [data, scope]);

  const deptColor = useMemo(() => {
    const map = new Map<string, string>();
    for (const dept of data?.departments ?? []) map.set(dept.id, dept.color);
    return map;
  }, [data]);

  function cellKey(rowKey: string, col: Date): string {
    return `${rowKey}|${projectColumnKey(col, zoom)}`;
  }

  function scrollPlanHeader(selector: string) {
    const target = gridWrapRef.current?.querySelector(selector);
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function changeZoom(next: PlanZoom) {
    setZoom(next);
    writeZoom(ZOOM_KEY, next);
  }

  function startPickingDeps() {
    pickSnapshot.current = draft.predecessor_ids;
    setPickingDeps(true);
  }

  function togglePickedDep(taskId: string) {
    if (taskId === editing?.id) return;
    setDraft((prev) => {
      const has = prev.predecessor_ids.includes(taskId);
      return {
        ...prev,
        predecessor_ids: has ? prev.predecessor_ids.filter((id) => id !== taskId) : [...prev.predecessor_ids, taskId],
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
    setPickingDeps(false);
    setEditing(null);
  }

  function selectedDepTasks(): PlanTask[] {
    const ids = new Set(draft.predecessor_ids);
    return (data?.tasks || []).filter((task) => ids.has(task.id));
  }

  function openEdit(task: PlanTask) {
    if (pickingDeps) {
      if (!editing || task.project_id !== editing.project_id) return;
      togglePickedDep(task.id);
      return;
    }
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
    if (!editing) return;
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
  }

  async function toggleTask(task: PlanTask) {
    if (!task.can_complete && task.status === "open") return;
    if (task.blocked && task.status === "open") return;
    setError("");
    try {
      await api.updatePlanTask(task.id, { status: task.status === "done" ? "open" : "done" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update task");
    }
  }

  async function submitSubtask() {
    if (!editing || editing.parent_id || !canManageTask(editing)) return;
    const title = subtaskDraft.title.trim();
    if (!title) return;
    setError("");
    try {
      await api.createPlanTask(editing.project_id, {
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
      setEditing({ ...latest, project_name: latest.project_name || task.project_name });
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
      setEditing({ ...latest, project_name: latest.project_name || task.project_name });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove file");
    }
  }

  const todayLabel = zoom === "day" ? "Today" : zoom === "month" ? "This month" : "This week";
  const showBars = planView === "bars" && !pickingDeps;
  const showProjects = planView === "projects" && !pickingDeps;
  const showDepartmentScope = canSeePeople || leadIds.length > 0;
  const emptyDepartment = scope === "department" && leadIds.length === 0;
  const leadText =
    scope === "people"
      ? "Tasks assigned to each person, across projects."
      : scope === "department"
        ? "Tasks in the departments you lead, one row per person."
        : "Tasks assigned to you, across projects.";

  return (
    <div className="shell">
      <OrgSidebar active="todos" />
      <main className="main plan">
        <div className="main-head plan-toolbar">
          <div>
            <Link className="hint plan-back" to="/org">
              ← <span className="plan-back-full">Organization</span>
              <span className="plan-back-short">Org</span>
            </Link>
            <h1>My Org Todo's</h1>
            <p className="hint plan-toolbar-lead" style={{ margin: "4px 0 0" }}>
              {leadText}
            </p>
          </div>
          <div className="composer-row">
            {canSeePeople || showDepartmentScope ? (
              <div className="plan-zoom" role="group" aria-label="Whose tasks">
                <button
                  className={`btn ghost small${scope === "mine" ? " on" : ""}`}
                  type="button"
                  onClick={() => setScope("mine")}
                >
                  Only my row
                </button>
                {canSeePeople ? (
                  <button
                    className={`btn ghost small${scope === "people" ? " on" : ""}`}
                    type="button"
                    onClick={() => setScope("people")}
                  >
                    All people
                  </button>
                ) : null}
                {showDepartmentScope ? (
                  <button
                    className={`btn ghost small${scope === "department" ? " on" : ""}`}
                    type="button"
                    onClick={() => setScope("department")}
                  >
                    My department
                  </button>
                ) : null}
              </div>
            ) : null}
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
        {!data && !error ? <p className="hint">Loading…</p> : null}
        {emptyDepartment ? (
          <p className="hint">You are not marked as lead of a department yet. Ask an admin to assign you.</p>
        ) : null}
        {data && !emptyDepartment ? (
          <div
            ref={gridWrapRef}
            className={`plan-grid-wrap${pickingDeps ? " picking-deps" : ""}`}
            style={whoColumn.width != null ? { ["--plan-dept-col" as string]: `${whoColumn.width}px` } : undefined}
          >
            <div
              className={`plan-grid${showProjects ? " plan-spans" : ""}`}
              style={{
                ["--weeks" as string]: columns.length,
                ["--plan-col-min" as string]: zoom === "day" ? "108px" : "148px",
              }}
            >
              <div className="plan-corner">
                <span className="plan-corner-label">Who</span>
                <PlanWhoResizeHandle width={whoColumn.width} onCommit={whoColumn.commit} onReset={whoColumn.reset} />
              </div>
              {columns.map((col, index) => {
                const meta = formatProjectHeader(col, zoom, index > 0 ? columns[index - 1] : null);
                return (
                  <div className={`plan-week${isCurrentPlanColumn(col, zoom) ? " current" : ""}`} key={projectColumnKey(col, zoom)}>
                    <div className="plan-week-head">
                      <strong>{meta.title}</strong>
                      {meta.year ? <span className="plan-year">{meta.year}</span> : null}
                    </div>
                    {meta.sub ? <span className="hint">{meta.sub}</span> : null}
                  </div>
                );
              })}
              {rows.map((row, rowIndex) => {
                const gridRow = rowIndex + 2;
                return [
                <div
                  className="plan-dept plan-person"
                  key={`d-${row.key}`}
                  style={{
                    ...(showProjects ? { gridRow, gridColumn: 1 } : null),
                    background: `color-mix(in srgb, ${ROW_COLOR} 16%, var(--bg-raised))`,
                  }}
                >
                  <span className="dot" style={{ background: ROW_COLOR }} />
                  <span className="plan-dept-name">{row.name}</span>
                </div>,
                ...columns.map((col, colIndex) => {
                  const key = cellKey(row.key, col);
                  const tasks = tasksByCell.get(key) || [];
                  return (
                    <div
                      className={`plan-cell${isCurrentPlanColumn(col, zoom) ? " current" : ""}`}
                      key={key}
                      style={showProjects ? { gridRow, gridColumn: colIndex + 2 } : undefined}
                    >
                      {showBars ? (
                        <PlanWorkloadBar count={tasks.length} />
                      ) : showProjects ? null : (
                        tasks.map((task) => {
                          const color = (task.department_id && deptColor.get(task.department_id)) || ROW_COLOR;
                          const sameProject = Boolean(editing && task.project_id === editing.project_id);
                          return (
                            <button
                              key={task.id}
                              type="button"
                              className={`plan-chip${task.status === "done" ? " done" : ""}${task.blocked ? " blocked" : ""}${pickingDeps && sameProject && draft.predecessor_ids.includes(task.id) ? " dep-picked" : ""}${pickingDeps && task.id === editing?.id ? " dep-source" : ""}`}
                              style={{ background: `color-mix(in srgb, ${color} 28%, var(--bg-card))` }}
                              onClick={() => openEdit(task)}
                            >
                              <span className="plan-chip-who">{task.project_name || "Project"}</span>
                              <span className="plan-chip-title">{task.title}</span>
                              {zoom !== "day" ? <span className="hint">{formatChipDay(taskDueOn(task))}</span> : null}
                              {task.blocked ? <span className="hint">Waiting</span> : null}
                            </button>
                          );
                        })
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
          </div>
        ) : null}
        {editing ? (
          <PlanTaskEditor
            editing={editing}
            pickingDeps={pickingDeps}
            draft={draft}
            onDraftChange={setDraft}
            canEdit={canManageTask(editing)}
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
            onToggleStatus={() => void toggleTask(editing)}
            onDelete={() => void removeTask(editing)}
            onStartPickingDeps={startPickingDeps}
            onConfirmPickedDeps={confirmPickedDeps}
            onCancelPickedDeps={cancelPickedDeps}
            onOpenAttachment={(att) => setLightbox(lightboxFor(att))}
            onAttach={(files) => void attachToTask(editing, files)}
            onDetach={(attachmentId) => void detachFromTask(editing, attachmentId)}
            onOpenSubtask={(child) => {
              const full = data?.tasks.find((row) => row.id === child.id);
              if (full) openEdit(full);
            }}
            onToggleSubtask={(child) => void toggleSubtask(child)}
            onSubmitSubtask={() => void submitSubtask()}
            projectName={editing.project_name || "Project"}
            projectHref={`/org/projects/${editing.project_id}`}
            dependsHint={`Click other tasks from ${editing.project_name || "this project"}. Those become the tasks this one depends on.`}
          />
        ) : null}
        {lightbox ? <LightboxOverlay lightbox={lightbox} onClose={() => setLightbox(null)} /> : null}
      </main>
    </div>
  );
}
