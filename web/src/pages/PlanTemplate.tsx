import { type DragEvent, type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type PlanDepartment, type PlanTemplateTask } from "../api";
import OrgSidebar from "../components/OrgSidebar";
import { applyDepartmentSort, cellInsertBeforeId, nextDeptSort, orderDepartmentIds } from "../planOrder";
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
    predecessor_keys: task.predecessor_ids,
    sort_order: task.sort_order,
  };
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
  const [zoom, setZoom] = useState<PlanZoom>(() => readZoom(ZOOM_KEY));
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [dropChipKey, setDropChipKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<DraftTask | "new" | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    notes: "",
    department_id: "",
    day_offset: 0,
    notify_days: "",
    predecessor_keys: [] as string[],
  });
  const draggingKey = useRef<string | null>(null);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const scrolledKey = useRef<string | null>(null);
  const [pickingDeps, setPickingDeps] = useState(false);
  const pickSnapshot = useRef<string[]>([]);
  const unit = templateUnit(zoom);

  async function load() {
    if (!templateId) return;
    setError("");
    try {
      const [template, overview] = await Promise.all([api.getPlanTemplate(templateId), api.planOverview()]);
      setName(template.name);
      setDirection(template.schedule_direction === "backward" ? "backward" : "forward");
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

  const columns = useMemo(
    () => templateColumnsSpanning(tasks.map((task) => templateColOf(task.day_offset, zoom))),
    [tasks, zoom],
  );

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
    for (const task of tasks) {
      const key = `${task.department_id || "none"}|${templateColOf(task.day_offset, zoom)}`;
      const list = map.get(key) || [];
      list.push(task);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [tasks, zoom]);

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

  async function persist(nextName: string, nextTasks: DraftTask[], nextDirection: ScheduleDirection = direction) {
    if (!templateId) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api.savePlanTemplate(templateId, {
        name: nextName.trim() || name,
        schedule_direction: nextDirection,
        tasks: nextTasks
          .filter((task) => task.title.trim())
          .map((task) => ({
            id: task.id || task.key,
            title: task.title.trim(),
            notes: task.notes.trim() || null,
            department_id: task.department_id || null,
            day_offset: Math.max(0, Number(task.day_offset) || 0),
            notify_days_before: task.notify_days_before,
            sort_order: task.sort_order,
            predecessor_ids: task.predecessor_keys,
          })),
      });
      setName(saved.name);
      setDirection(saved.schedule_direction === "backward" ? "backward" : "forward");
      setTasks(saved.tasks.map(toDraft));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save template");
      await load();
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
    pickSnapshot.current = draft.predecessor_keys;
    setPickingDeps(true);
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
  }

  function selectedDepTasks(): DraftTask[] {
    const keys = new Set(draft.predecessor_keys);
    return tasks.filter((task) => keys.has(depKey(task)) || keys.has(task.key));
  }

  function openNew(departmentId: string, col: number) {
    if (!canEdit || pickingDeps) return;
    setEditing("new");
    setDraft({
      title: "",
      notes: "",
      department_id: departmentId,
      day_offset: templateNewOffset(col, zoom),
      notify_days: "",
      predecessor_keys: [],
    });
  }

  function openEdit(task: DraftTask) {
    if (pickingDeps) {
      togglePickedDep(task);
      return;
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
    const nextTask: DraftTask = {
      key: editing === "new" || !editing ? `tmp-${Date.now()}` : editing.key,
      id: editing === "new" || !editing ? undefined : editing.id,
      title,
      notes: draft.notes,
      department_id: draft.department_id,
      day_offset: Math.max(0, draft.day_offset),
      notify_days_before: parsedNotify,
      predecessor_keys: draft.predecessor_keys,
      sort_order:
        editing === "new" || !editing
          ? nextDeptSort(tasks, draft.department_id, (task) => task.department_id, (task) => task.sort_order)
          : editing.department_id !== draft.department_id
            ? nextDeptSort(
                tasks.filter((task) => task.key !== editing.key),
                draft.department_id,
                (task) => task.department_id,
                (task) => task.sort_order,
              )
            : editing.sort_order,
    };
    const next =
      editing === "new" || !editing
        ? [...tasks, nextTask]
        : tasks.map((task) => (task.key === nextTask.key ? nextTask : task));
    closeEditor();
    setTasks(next);
    await persist(name, next);
  }

  async function removeTask(task: DraftTask) {
    if (!confirm(`Delete “${task.title}”?`)) return;
    const next = tasks
      .filter((row) => row.key !== task.key)
      .map((row) => ({
        ...row,
        predecessor_keys: row.predecessor_keys.filter((key) => key !== task.key && key !== task.id),
      }));
    closeEditor();
    setTasks(next);
    await persist(name, next);
  }

  function onTaskDragStart(e: DragEvent, task: DraftTask) {
    if (!canEdit || pickingDeps) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(TASK_MIME, task.key);
    e.dataTransfer.setData("text/plain", task.key);
    e.dataTransfer.effectAllowed = "move";
    draggingKey.current = task.key;
  }

  async function onCellDrop(e: DragEvent, departmentId: string, col: number, beforeKey?: string) {
    e.preventDefault();
    setDropKey(null);
    setDropChipKey(null);
    const key = e.dataTransfer.getData(TASK_MIME) || draggingKey.current;
    draggingKey.current = null;
    if (!key || !canEdit || pickingDeps) return;
    if (beforeKey && beforeKey === key) return;
    const dragged = tasks.find((task) => task.key === key);
    if (!dragged) return;
    const moved: DraftTask = {
      ...dragged,
      department_id: departmentId,
      day_offset: templateDropOffset(dragged.day_offset, col, zoom),
    };
    const relocated = tasks.map((task) => (task.key === key ? moved : task));
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
    const next = applyDepartmentSort(relocated, departmentId, ordered, (task) => task.key, (task) => task.department_id);
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
    setDirection(next);
    await persist(name, tasks, next);
  }

  const deliveryCol = useMemo(
    () => tasks.reduce((max, task) => Math.max(max, templateColOf(task.day_offset, zoom)), 0),
    [tasks, zoom],
  );
  const spanOffset = useMemo(() => {
    let max = 0;
    for (const task of tasks) {
      if (editing && editing !== "new" && editing.key === task.key) continue;
      max = Math.max(max, Math.max(0, task.day_offset));
    }
    return Math.max(max, Math.max(0, draft.day_offset));
  }, [tasks, editing, draft.day_offset]);
  const daysBefore = Math.max(0, spanOffset - Math.max(0, draft.day_offset));
  const editorSource = direction === "backward" ? daysBefore : draft.day_offset;
  const editorValue = zoom === "day" ? editorSource : Math.floor(editorSource / unit);
  const editorRemainder = zoom === "day" ? 0 : editorSource % unit;
  const editorLabel =
    direction === "backward"
      ? zoom === "day"
        ? "Days before delivery"
        : zoom === "week"
          ? "Weeks before delivery"
          : "Months before delivery"
      : zoom === "day"
        ? "Days after start"
        : zoom === "week"
          ? "Weeks after start"
          : "Months after start";
  const zoomHint =
    direction === "backward"
      ? zoom === "day"
        ? "Columns lead up to delivery. The latest column is the delivery date when you create a project."
        : zoom === "week"
          ? "Columns lead up to delivery. Dropping keeps the weekday."
          : "Columns lead up to delivery in 4-week months. Dropping keeps the day within the month."
      : zoom === "day"
        ? "Columns are days after a project starts."
        : zoom === "week"
          ? "Columns are weeks after a project starts. Dropping keeps the weekday."
          : "Columns are 4-week months after a project starts. Dropping keeps the day within the month.";

  function setEditorOffset(next: number) {
    const amount = Math.max(0, next) * unit + editorRemainder;
    if (direction === "backward") {
      setDraft({ ...draft, day_offset: Math.max(0, spanOffset - amount) });
      return;
    }
    setDraft({ ...draft, day_offset: amount });
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
        {!loaded ? (
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
              {columns.map((col) => (
                <div className="plan-week" data-plan-col={col} key={col}>
                  <strong>{templateHeading(col, zoom, direction, deliveryCol)}</strong>
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
                        className={`plan-cell${dropKey === key ? " drag-over" : ""}`}
                        key={key}
                        onDragOver={(e) => {
                          if (!canEdit || pickingDeps) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          setDropKey(key);
                          setDropChipKey(null);
                        }}
                        onDragLeave={() => setDropKey((cur) => (cur === key ? null : cur))}
                        onDrop={(e) => void onCellDrop(e, deptId, col)}
                        onDoubleClick={() => {
                          if (!pickingDeps) openNew(deptId, col);
                        }}
                      >
                        {cellTasks.map((task) => (
                          <button
                            key={task.key}
                            type="button"
                            className={`plan-chip${task.predecessor_keys.length ? " blocked" : ""}${pickingDeps && isPickedDep(task) ? " dep-picked" : ""}${pickingDeps && task.key === editingTaskKey() ? " dep-source" : ""}${dropChipKey === task.key ? " drop-before" : ""}`}
                            style={{ background: `color-mix(in srgb, ${dept.color} 28%, var(--bg-card))` }}
                            draggable={canEdit && !pickingDeps}
                            onDragStart={(e) => onTaskDragStart(e, task)}
                            onDragEnd={() => {
                              draggingKey.current = null;
                              setDropKey(null);
                              setDropChipKey(null);
                            }}
                            onDragOver={(e) => {
                              if (!canEdit || pickingDeps) return;
                              if (draggingKey.current === task.key) return;
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
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
                            onClick={() => openEdit(task)}
                          >
                            <span className="plan-chip-title">{task.title || "Untitled"}</span>
                            {task.predecessor_keys.length ? (
                              <span className="hint">Depends on {task.predecessor_keys.length}</span>
                            ) : null}
                          </button>
                        ))}
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
            <form className="panel" onSubmit={(e) => void saveTask(e)}>
              <h2>{editing === "new" ? "New task" : "Task"}</h2>
              <label>
                Title
                <input
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
              {canEdit ? (
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
                      min={0}
                      max={
                        direction === "backward"
                          ? zoom === "day"
                            ? spanOffset
                            : Math.floor(spanOffset / unit)
                          : zoom === "day"
                            ? 365
                            : zoom === "week"
                              ? 52
                              : 24
                      }
                      value={editorValue}
                      onChange={(e) => setEditorOffset(Number(e.target.value) || 0)}
                    />
                  </label>
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
          </div>
        ) : null}
      </main>
    </div>
  );
}
