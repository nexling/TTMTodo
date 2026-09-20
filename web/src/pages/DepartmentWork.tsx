import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Attachment, type Membership, type PlanDepartmentWork, type PlanTask } from "../api";
import { useLiveReload } from "../live";
import { PlanAssigneeSelect } from "../components/PlanAssigneeSelect";
import OrgSidebar from "../components/OrgSidebar";
import {
  AttachmentBlock,
  FILE_ACCEPT,
  LightboxOverlay,
  lightboxFor,
  type Lightbox,
} from "../components/ItemCard";
import { ShiftRelatedDialog, useShiftFlow } from "../components/ShiftRelatedDialog";
import {
  ZOOM_COUNTS,
  ZOOM_OPTIONS,
  alignAnchor,
  dayDelta,
  formatChipDay,
  formatProjectHeader,
  projectColumns,
  projectColumnKey,
  projectTaskColumnKey,
  readZoom,
  stepAnchor,
  taskDueOn,
  todayAnchor,
  writeZoom,
  ymd,
  type PlanZoom,
} from "../planZoom";

const ZOOM_KEY = "magictodo:plan-zoom:department";

function memberLabel(row: Membership | undefined): string {
  const user = row?.user;
  return user?.name || user?.email || user?.username || "Unassigned";
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

export default function DepartmentWork() {
  const [data, setData] = useState<PlanDepartmentWork | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<PlanZoom>(() => readZoom(ZOOM_KEY));
  const [anchor, setAnchor] = useState(() => todayAnchor(readZoom(ZOOM_KEY)));
  const [editing, setEditing] = useState<PlanTask | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    notes: "",
    department_id: "",
    assignee_user_id: "",
    due_on: ymd(new Date()),
    predecessor_ids: [] as string[],
  });
  const [pickingDeps, setPickingDeps] = useState(false);
  const pickSnapshot = useRef<string[]>([]);
  const { shiftPrompt, shiftBusy, beginShiftFlow, resolveShiftPrompt } = useShiftFlow();
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const leadIds = data?.lead_department_ids ?? [];
  const lead = leadIds.length > 0;
  const admin = Boolean(data?.capabilities.can_manage_project_work || data?.capabilities.can_manage_plan);
  const canManageWork = admin;
  const colCount = ZOOM_COUNTS[zoom];

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
      const next = await api.departmentWork();
      setData(next);
      setEditing((cur) => {
        if (!cur) return cur;
        return next.tasks.find((task) => task.id === cur.id) ?? cur;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load department work");
      setData(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useLiveReload(
    (event) => event.channel === "plan",
    () => load(),
  );

  const columns = useMemo(() => projectColumns(anchor, zoom), [anchor, zoom]);

  const tasksByCell = useMemo(() => {
    const map = new Map<string, PlanTask[]>();
    for (const task of data?.tasks ?? []) {
      const key = `${task.department_id || "none"}|${projectTaskColumnKey(taskDueOn(task), zoom)}`;
      const list = map.get(key) || [];
      list.push(task);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [data, zoom]);

  function cellKey(departmentId: string | null, col: Date): string {
    return `${departmentId || "none"}|${projectColumnKey(col, zoom)}`;
  }

  function changeZoom(next: PlanZoom) {
    setZoom(next);
    writeZoom(ZOOM_KEY, next);
    setAnchor((cur) => alignAnchor(cur, next));
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
    setEditing(task);
    setDraft({
      title: task.title,
      notes: task.notes || "",
      department_id: task.department_id || "",
      assignee_user_id: task.assignee_user_id || "",
      due_on: taskDueOn(task),
      predecessor_ids: task.predecessor_ids,
    });
  }

  async function saveTask(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const title = draft.title.trim();
    if (!title) return;
    const body = {
      title,
      notes: draft.notes.trim() || null,
      department_id: draft.department_id || null,
      assignee_user_id: draft.assignee_user_id || null,
      due_on: draft.due_on,
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

  const rows = [
    ...(data?.departments ?? []),
    ...(canManageWork
      ? [{ id: "", name: "Unassigned", color: "#3a3428", member_ids: [] as string[], lead_ids: [] as string[] }]
      : []),
  ];
  const todayLabel = zoom === "day" ? "Today" : zoom === "month" ? "This month" : "This week";

  return (
    <div className="shell">
      <OrgSidebar active="department" />
      <main className="main plan">
        <div className="main-head plan-toolbar">
          <div>
            <Link className="hint plan-back" to="/org">
              ← <span className="plan-back-full">Organization</span>
              <span className="plan-back-short">Org</span>
            </Link>
            <h1>Department work</h1>
            <p className="hint plan-toolbar-lead" style={{ margin: "4px 0 0" }}>
              {admin
                ? "Open tasks for every department, across projects."
                : lead
                  ? "Open tasks for the departments you lead, across every project."
                  : "Department leads see every task in their departments here."}
            </p>
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
            <button className="btn ghost small" type="button" onClick={() => setAnchor(stepAnchor(anchor, zoom, -1))}>
              ‹ Earlier
            </button>
            <button className="btn ghost small" type="button" onClick={() => setAnchor(todayAnchor(zoom))}>
              {todayLabel}
            </button>
            <button className="btn ghost small" type="button" onClick={() => setAnchor(stepAnchor(anchor, zoom, 1))}>
              Later ›
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
        {data && data.departments.length === 0 && !canManageWork ? (
          <p className="hint">
            {lead
              ? "You are not marked as lead of a department yet. Ask an admin to assign you."
              : "No departments yet."}
          </p>
        ) : null}
        {data && (data.departments.length > 0 || canManageWork) ? (
          <div className={`plan-grid-wrap${pickingDeps ? " picking-deps" : ""}`}>
            <div
              className="plan-grid"
              style={{
                ["--weeks" as string]: colCount,
                ["--plan-col-min" as string]: zoom === "day" ? "108px" : "148px",
              }}
            >
              <div className="plan-corner">
                <span className="plan-corner-label">Department</span>
              </div>
              {columns.map((col, index) => {
                const meta = formatProjectHeader(col, zoom, index > 0 ? columns[index - 1] : null);
                return (
                  <div className="plan-week" key={projectColumnKey(col, zoom)}>
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
                      <div className="plan-cell" key={key}>
                        {tasks.map((task) => {
                          const sameProject = Boolean(editing && task.project_id === editing.project_id);
                          return (
                            <button
                              key={task.id}
                              type="button"
                              className={`plan-chip${task.status === "done" ? " done" : ""}${task.blocked ? " blocked" : ""}${pickingDeps && sameProject && draft.predecessor_ids.includes(task.id) ? " dep-picked" : ""}${pickingDeps && task.id === editing?.id ? " dep-source" : ""}`}
                              style={{ background: `color-mix(in srgb, ${dept.color} 28%, var(--bg-card))` }}
                              onClick={() => openEdit(task)}
                            >
                              <span className="plan-chip-who">{task.project_name || "Project"}</span>
                              <span className="plan-chip-title">{task.title}</span>
                              <span className="hint">
                                {task.assignee
                                  ? memberLabel({ user: task.assignee, user_id: task.assignee.id } as Membership)
                                  : "Unassigned"}
                              </span>
                              {zoom !== "day" ? <span className="hint">{formatChipDay(taskDueOn(task))}</span> : null}
                              {task.blocked ? <span className="hint">Waiting</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    );
                  }),
                ];
              })}
            </div>
          </div>
        ) : null}

        {editing && pickingDeps ? (
          <div className="plan-editor plan-dep-picker">
            <div className="panel">
              <h2>Assign depending tasks</h2>
              <p className="hint">
                Click other tasks from {editing.project_name || "this project"}. Those become the tasks this one depends
                on.
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
            <form className="panel" onSubmit={(e) => void saveTask(e)}>
              <h2>Task</h2>
              {(() => {
                const canEdit = canManageTask(editing);
                const deptOptions = canManageWork
                  ? data?.departments ?? []
                  : (data?.departments ?? []).filter((dept) => leadIds.includes(dept.id) || dept.id === draft.department_id);
                const attachments = editing.attachments ?? [];
                return (
                  <>
                    <p className="hint" style={{ margin: "0 0 10px" }}>
                      {editing.project_name || "Project"}
                    </p>
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
                            {canManageWork ? <option value="">Unassigned</option> : null}
                            {deptOptions.map((dept) => (
                              <option key={dept.id} value={dept.id}>
                                {dept.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Assigned to
                          <PlanAssigneeSelect
                            value={draft.assignee_user_id}
                            onChange={(userId) => setDraft({ ...draft, assignee_user_id: userId })}
                            members={data?.members ?? []}
                            departmentMemberIds={
                              data?.departments.find((dept) => dept.id === draft.department_id)?.member_ids ?? []
                            }
                          />
                        </label>
                        <label>
                          Date
                          <input
                            type="date"
                            value={draft.due_on}
                            onChange={(e) => setDraft({ ...draft, due_on: e.target.value })}
                          />
                        </label>
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
                      </>
                    ) : null}
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
                    <div className="composer-row">
                      {editing.can_complete || editing.status === "done" ? (
                        <button className="btn" type="button" onClick={() => void toggleTask(editing)}>
                          {editing.status === "done" ? "Reopen" : "Mark done"}
                        </button>
                      ) : null}
                      {canEdit ? (
                        <button className="btn" type="submit">
                          Save
                        </button>
                      ) : null}
                      {canEdit ? (
                        <button className="btn ghost" type="button" onClick={() => void removeTask(editing)}>
                          Delete
                        </button>
                      ) : null}
                      <Link className="btn ghost" to={`/org/projects/${editing.project_id}`}>
                        Open project
                      </Link>
                      <button className="btn ghost" type="button" onClick={closeEditor}>
                        Close
                      </button>
                    </div>
                  </>
                );
              })()}
            </form>
          </div>
        ) : null}
        {lightbox ? <LightboxOverlay lightbox={lightbox} onClose={() => setLightbox(null)} /> : null}
      </main>
    </div>
  );
}
