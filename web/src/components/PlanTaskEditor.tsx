import { type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  type Attachment,
  type Membership,
  type PlanDepartment,
  type PlanSubtask,
  type PlanTask,
} from "../api";
import { AttachmentBlock, FILE_ACCEPT } from "./ItemCard";
import { PlanAssigneeSelect, memberLabel } from "./PlanAssigneeSelect";
import PlanEditorResizeHandle from "./PlanEditorResizeHandle";

export type PlanTaskDraft = {
  title: string;
  notes: string;
  department_id: string;
  assignee_user_id: string;
  due_on: string;
  notify_days: string;
  predecessor_ids: string[];
};

export type PlanSubtaskDraft = {
  title: string;
  assignee_user_id: string;
};

export function parseNotifyDays(raw: string): number | null | "invalid" {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return "invalid";
  const n = Number(text);
  if (n > 365) return "invalid";
  return n;
}

export function notifyDaysInput(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

const DEFAULT_DEPENDS_HINT = "Click one or more other tasks on the board. Those become the tasks this one depends on.";

export default function PlanTaskEditor(props: {
  editing: PlanTask | "new";
  pickingDeps: boolean;
  draft: PlanTaskDraft;
  onDraftChange: (draft: PlanTaskDraft) => void;
  canEdit: boolean;
  departments: PlanDepartment[];
  allowUnassigned: boolean;
  members: Membership[];
  departmentMemberIds: string[];
  selectedDeps: { id: string; title: string }[];
  attachBusy: boolean;
  subtaskDraft: PlanSubtaskDraft;
  onSubtaskDraftChange: (draft: PlanSubtaskDraft) => void;
  onSave: (e: FormEvent) => void;
  onClose: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
  onStartPickingDeps: () => void;
  onConfirmPickedDeps: () => void;
  onCancelPickedDeps: () => void;
  onOpenAttachment: (att: Attachment) => void;
  onAttach: (files: File[]) => void;
  onDetach: (attachmentId: string) => void;
  onOpenSubtask: (child: PlanSubtask) => void;
  onToggleSubtask: (child: PlanSubtask) => void;
  onSubmitSubtask: () => void;
  projectName?: string | null;
  projectHref?: string | null;
  dependsHint?: string;
}) {
  const {
    editing,
    pickingDeps,
    draft,
    onDraftChange,
    canEdit,
    departments,
    allowUnassigned,
    members,
    departmentMemberIds,
    selectedDeps,
    attachBusy,
    subtaskDraft,
    onSubtaskDraftChange,
    projectName,
    projectHref,
    dependsHint,
  } = props;
  const existing = editing === "new" ? null : editing;
  const isChild = Boolean(existing?.parent_id);
  const showSubtasks = Boolean(existing && !existing.parent_id);
  const attachments = existing?.attachments ?? [];
  const children = showSubtasks ? existing?.subtasks ?? [] : [];
  const canToggle = Boolean(existing && (existing.can_complete || existing.status === "done"));

  return (
    <>
      <PlanEditorResizeHandle />
      {pickingDeps ? (
        <div className="plan-editor plan-dep-picker">
          <div className="panel">
            <h2>Assign depending tasks</h2>
            <p className="hint">{dependsHint || DEFAULT_DEPENDS_HINT}</p>
            <p>
              Selected: {draft.predecessor_ids.length} {draft.predecessor_ids.length === 1 ? "task" : "tasks"}
              {selectedDeps.length ? ` — ${selectedDeps.map((task) => task.title).join(", ")}` : ""}
            </p>
            <div className="composer-row">
              <button className="btn" type="button" onClick={props.onConfirmPickedDeps}>
                Confirm
              </button>
              <button className="btn ghost" type="button" onClick={props.onCancelPickedDeps}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="plan-editor">
          <div className={`plan-editor-layout${showSubtasks ? " has-subtasks" : ""}`}>
            <form className="panel" onSubmit={props.onSave}>
              <div className="plan-editor-head">
                <div>
                  <h2>{editing === "new" ? "New task" : isChild ? "Subtask" : "Task"}</h2>
                  {projectName ? <p className="hint" style={{ margin: "4px 0 0" }}>{projectName}</p> : null}
                </div>
                <div className="composer-row">
                  {canToggle && existing ? (
                    <button className="btn" type="button" onClick={props.onToggleStatus}>
                      {existing.status === "done" ? "Reopen" : "Mark done"}
                    </button>
                  ) : null}
                  {canEdit ? (
                    <button className="btn" type="submit">
                      Save
                    </button>
                  ) : null}
                  {canEdit && existing ? (
                    <button className="btn ghost" type="button" onClick={props.onDelete}>
                      Delete
                    </button>
                  ) : null}
                  {projectHref ? (
                    <Link className="btn ghost" to={projectHref}>
                      Open project
                    </Link>
                  ) : null}
                  <button className="btn ghost" type="button" onClick={props.onClose}>
                    Close
                  </button>
                </div>
              </div>
              <label>
                Title
                <input
                  value={draft.title}
                  onChange={(e) => onDraftChange({ ...draft, title: e.target.value })}
                  required
                  maxLength={500}
                  disabled={!canEdit}
                />
              </label>
              <label>
                Notes
                <textarea
                  value={draft.notes}
                  onChange={(e) => onDraftChange({ ...draft, notes: e.target.value })}
                  rows={3}
                  disabled={!canEdit}
                />
              </label>
              {canEdit ? (
                <div className={`plan-editor-row${isChild ? " single" : ""}`}>
                  {isChild ? null : (
                    <label>
                      Department
                      <select
                        value={draft.department_id}
                        onChange={(e) => onDraftChange({ ...draft, department_id: e.target.value })}
                      >
                        {allowUnassigned ? <option value="">Unassigned</option> : null}
                        {departments.map((dept) => (
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
                      onChange={(userId) => onDraftChange({ ...draft, assignee_user_id: userId })}
                      members={members}
                      departmentMemberIds={departmentMemberIds}
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
                        onChange={(e) => onDraftChange({ ...draft, due_on: e.target.value })}
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
                        onChange={(e) => onDraftChange({ ...draft, notify_days: e.target.value })}
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
                    {selectedDeps.length ? (
                      <ul className="plan-dep-list">
                        {selectedDeps.map((task) => (
                          <li key={task.id}>{task.title}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="hint">No depending tasks yet.</p>
                    )}
                    <button className="btn" type="button" onClick={props.onStartPickingDeps}>
                      Assign depending tasks
                    </button>
                  </div>
                  {existing ? (
                    <AttachmentField
                      attachments={attachments}
                      attachBusy={attachBusy}
                      canRemove
                      onOpen={props.onOpenAttachment}
                      onAttach={props.onAttach}
                      onDetach={props.onDetach}
                    />
                  ) : (
                    <p className="hint">Save the task to add attachments.</p>
                  )}
                </div>
              ) : existing ? (
                <AttachmentField
                  attachments={attachments}
                  attachBusy={attachBusy}
                  canRemove={canEdit}
                  onOpen={props.onOpenAttachment}
                  onAttach={props.onAttach}
                  onDetach={props.onDetach}
                />
              ) : (
                <p className="hint">Save the task to add attachments.</p>
              )}
            </form>
            {showSubtasks && existing ? (
              <div className="panel plan-subtasks">
                <h2>Subtasks</h2>
                {children.length ? (
                  <ul className="plan-subtask-list">
                    {children.map((child) => (
                      <li key={child.id}>
                        <button
                          type="button"
                          className={`plan-subtask-row${child.status === "done" ? " done" : ""}`}
                          onClick={() => props.onOpenSubtask(child)}
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
                          <button className="btn ghost small" type="button" onClick={() => props.onToggleSubtask(child)}>
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
                      onChange={(e) => onSubtaskDraftChange({ ...subtaskDraft, title: e.target.value })}
                      placeholder="Add subtask"
                      maxLength={500}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          props.onSubmitSubtask();
                        }
                      }}
                    />
                    <PlanAssigneeSelect
                      value={subtaskDraft.assignee_user_id}
                      onChange={(userId) => onSubtaskDraftChange({ ...subtaskDraft, assignee_user_id: userId })}
                      members={members}
                      departmentMemberIds={departmentMemberIds}
                    />
                    <button className="btn" type="button" onClick={props.onSubmitSubtask}>
                      Add
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function AttachmentField(props: {
  attachments: Attachment[];
  attachBusy: boolean;
  canRemove: boolean;
  onOpen: (att: Attachment) => void;
  onAttach: (files: File[]) => void;
  onDetach: (attachmentId: string) => void;
}) {
  return (
    <div className="plan-dep-field">
      <span>Attachments</span>
      {props.attachments.length ? (
        <div className="thumbs">
          {props.attachments.map((att) => (
            <AttachmentBlock
              key={att.id}
              att={att}
              onOpen={props.onOpen}
              onRemove={props.canRemove ? () => props.onDetach(att.id) : undefined}
            />
          ))}
        </div>
      ) : (
        <p className="hint">No files yet.</p>
      )}
      {props.canRemove ? (
        <label className="btn ghost small file-btn">
          {props.attachBusy ? "Adding…" : "Attach"}
          <input
            type="file"
            multiple
            accept={FILE_ACCEPT}
            disabled={props.attachBusy}
            onChange={(e) => {
              const chosen = e.target.files;
              if (chosen?.length) props.onAttach(Array.from(chosen));
              e.target.value = "";
            }}
          />
        </label>
      ) : null}
    </div>
  );
}
