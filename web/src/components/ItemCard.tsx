import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type TextareaHTMLAttributes, useLayoutEffect, useRef, useEffect, useState } from "react";
import { type Attachment, type Bucket, type Item } from "../api";
import { bucketOptionLabel, walkBucketTree } from "../bucketTree";
import { filesFromDataTransfer } from "../clipboardFiles";
import { formatRichText } from "../linkify";

function fitTextarea(el: HTMLTextAreaElement | null, extraRows = 1) {
  if (!el) return;
  el.style.height = "0px";
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  el.style.height = `${el.scrollHeight + extraRows * line}px`;
}

function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    fitTextarea(ref.current);
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}

const EDIT_SKIP_SEL =
  ".title, .notes, a, input, textarea, button, select, iframe, pre, .thumbs, .card-actions, .card-more, .color-menu, .meta, .step-form, .edit-fields, .preview";

const CONTEXT_SKIP_SEL = "a, input, textarea, select, iframe, .thumb";

type ActionMenu =
  | { kind: "button"; right: number; top: number; bottom: number }
  | { kind: "cursor"; x: number; y: number };

export const FILE_ACCEPT =
  "image/*,.pdf,.txt,.md,.csv,.json,.doc,.docx,.xls,.xlsx,.odt,.rtf,application/pdf,text/plain";

export const REMINDER_LEADS: { minutes: number; label: string; body: string }[] = [
  { minutes: 15, label: "15 minutes before", body: "Due in 15 minutes" },
  { minutes: 60, label: "1 hour before", body: "Due in 1 hour" },
  { minutes: 1440, label: "1 day before", body: "Due in 1 day" },
  { minutes: 2880, label: "2 days before", body: "Due in 2 days" },
  { minutes: 4320, label: "3 days before", body: "Due in 3 days" },
  { minutes: 10080, label: "1 week before", body: "Due in 1 week" },
];

const SNOOZE_OFFSETS: { minutes: number; label: string }[] = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "1 day" },
  { minutes: 2880, label: "2 days" },
  { minutes: 4320, label: "3 days" },
  { minutes: 10080, label: "1 week" },
];

export type Lightbox = {
  kind: "image" | "pdf" | "text" | "file";
  url: string;
  name: string;
};

export type CardProps = {
  item: Item;
  buckets: Bucket[];
  isStep?: boolean;
  depth?: number;
  folded?: boolean;
  focused?: boolean;
  foldable?: boolean;
  allView?: boolean;
  allowReorder?: boolean;
  draggingId: string | null;
  dropItemId: string | null;
  dropFileItemId: string | null;
  dragReadyId: string | null;
  editingId: string | null;
  editTitle: string;
  editNotes: string;
  editDue: string;
  editLead: string;
  editRecur: string;
  editRecurN: string;
  editRecurUnit: "day" | "week";
  addingStepFor: string | null;
  stepText: string;
  moveTargets: { id: string; label: string }[];
  onToggle: (item: Item) => void;
  onMove: (item: Item, dest: string) => void;
  onReparent: (item: Item, parentId: string | null) => void;
  onRemove: (item: Item) => void;
  onToggleFold: (item: Item) => void;
  onDragStart: (e: DragEvent, item: Item) => void;
  onDragEnd: () => void;
  onCardMouseDown: (e: MouseEvent, item: Item) => void;
  onCardDragOver: (e: DragEvent, item: Item) => void;
  onCardDragLeave: (e: DragEvent, item: Item) => void;
  onCardDrop: (e: DragEvent, item: Item) => void;
  onEditStart: (item: Item) => void;
  onEditTitle: (value: string) => void;
  onEditNotes: (value: string) => void;
  onEditDue: (value: string) => void;
  onEditLead: (value: string) => void;
  onEditRecur: (value: string) => void;
  onEditRecurN: (value: string) => void;
  onEditRecurUnit: (value: "day" | "week") => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onEditKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onAddStep: (parent: Item) => void;
  onStepText: (value: string) => void;
  onStepKey: (e: KeyboardEvent<HTMLTextAreaElement>, parent: Item) => void;
  onStepSave: (parent: Item) => void;
  onStepCancel: () => void;
  onLightbox: (att: Attachment) => void;
  onAttach: (item: Item, files: File[]) => void;
  onDetach: (item: Item, attachmentId: string) => void;
  onSendRemarkable: (item: Item) => void;
  onLater: (item: Item, minutes: number | null) => void;
  remarkableConfigured?: boolean;
  compact?: boolean;
  compactShowNotes?: boolean;
};

export type TreeCardProps = {
  item: Item;
  depth: number;
  viewDone: boolean;
  folded: Set<string>;
  focusId: string | null;
  cardProps: Omit<
    CardProps,
    "item" | "isStep" | "depth" | "folded" | "focused" | "foldable" | "moveTargets"
  > & { items: Item[] };
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.round((Date.now() - then) / 1000);
  if (Number.isNaN(s)) return "";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDueStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const dayDiff = Math.round(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
      86400000,
  );
  let day: string;
  if (dayDiff === 0) day = "today";
  else if (dayDiff === 1) day = "tomorrow";
  else if (dayDiff === -1) day = "yesterday";
  else if (dayDiff > 1 && dayDiff <= 6) day = d.toLocaleDateString([], { weekday: "short" });
  else {
    const opts: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
    };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    day = d.toLocaleDateString([], opts);
  }
  return `${day} ${time}`;
}

function dueMeta(item: Item): { text: string; kind: "overdue" | "soon" | "upcoming" } | null {
  if (!item.due_at) return null;
  const due = new Date(item.due_at).getTime();
  if (Number.isNaN(due)) return null;
  const stamp = formatDueStamp(item.due_at);
  const now = Date.now();
  if (item.status === "open" && due < now) {
    return { text: `overdue · ${stamp}`, kind: "overdue" };
  }
  if (item.status === "open" && item.reminder_lead_minutes) {
    const remindAt = due - item.reminder_lead_minutes * 60_000;
    if (remindAt <= now && now < due) {
      return { text: `due soon · ${stamp}`, kind: "soon" };
    }
  }
  return { text: `due ${stamp}`, kind: "upcoming" };
}

function countSteps(item: Item): number {
  return (item.subtasks ?? []).reduce((n, child) => n + 1 + countSteps(child), 0);
}

function recurLabel(item: Item): string | null {
  if (!item.recur_interval || !item.recur_unit) return null;
  const n = item.recur_interval;
  const unit = item.recur_unit;
  if (n === 1 && unit === "day") return "repeats daily";
  if (n === 1 && unit === "week") return "repeats weekly";
  if (n === 1 && unit === "month") return "repeats monthly";
  if (n === 1 && unit === "year") return "repeats yearly";
  const plural = n === 1 ? unit : `${unit}s`;
  return `repeats every ${n} ${plural}`;
}

function descendantIds(item: Item): Set<string> {
  const ids = new Set<string>([item.id]);
  for (const child of item.subtasks ?? []) {
    for (const id of descendantIds(child)) ids.add(id);
  }
  return ids;
}

function moveOptions(roots: Item[], item: Item): { id: string; label: string }[] {
  const skip = descendantIds(item);
  const out: { id: string; label: string }[] = [];
  function walk(nodes: Item[], depth: number) {
    for (const node of nodes) {
      if (skip.has(node.id)) continue;
      const title = (node.title?.trim() || "Untitled").slice(0, 48);
      out.push({ id: node.id, label: `${"— ".repeat(depth)}${title}` });
      walk(node.subtasks ?? [], depth + 1);
    }
  }
  walk(roots, 0);
  return out;
}

function isImageAtt(att: Attachment): boolean {
  return att.mime_type.startsWith("image/");
}

function isPdfAtt(att: Attachment): boolean {
  return att.mime_type === "application/pdf" || att.original_name.toLowerCase().endsWith(".pdf");
}

function isTextAtt(att: Attachment): boolean {
  const name = att.original_name.toLowerCase();
  return (
    att.mime_type.startsWith("text/") ||
    att.mime_type === "application/json" ||
    /\.(txt|md|csv|json)$/.test(name)
  );
}

export function lightboxFor(att: Attachment): Lightbox {
  if (isImageAtt(att)) return { kind: "image", url: att.url, name: att.original_name };
  if (isPdfAtt(att)) return { kind: "pdf", url: att.url, name: att.original_name };
  if (isTextAtt(att)) return { kind: "text", url: att.url, name: att.original_name };
  return { kind: "file", url: att.url, name: att.original_name };
}

export function FetchedText({ url, limit }: { url: string; limit?: number }) {
  const [text, setText] = useState("Loading…");
  useEffect(() => {
    let gone = false;
    void fetch(url, { credentials: "include" })
      .then((res) => res.text())
      .then((body) => {
        if (gone) return;
        setText(limit && body.length > limit ? `${body.slice(0, limit)}…` : body);
      })
      .catch(() => {
        if (!gone) setText("Could not load file");
      });
    return () => {
      gone = true;
    };
  }, [url, limit]);
  return <pre className="text-snippet">{text}</pre>;
}

function downloadAttachment(att: Attachment) {
  const a = document.createElement("a");
  a.href = `${att.url}?download=1`;
  a.download = att.original_name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function AttachmentBlock({
  att,
  onOpen,
  onRemove,
}: {
  att: Attachment;
  onOpen: (att: Attachment) => void;
  onRemove?: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
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
  }, [menu]);

  return (
    <div
      className="thumb"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {isImageAtt(att) ? (
        <img src={att.url} alt={att.original_name} onClick={() => onOpen(att)} />
      ) : isPdfAtt(att) ? (
        <>
          <iframe title={att.original_name} src={att.url} className="pdf-preview" />
          <button type="button" className="thumb-caption" onClick={() => onOpen(att)}>
            {att.original_name}
          </button>
          <button
            type="button"
            className="thumb-hit"
            aria-label={`Open ${att.original_name}`}
            onClick={() => onOpen(att)}
          />
        </>
      ) : isTextAtt(att) ? (
        <button type="button" className="text-preview-wrap" onClick={() => onOpen(att)}>
          <FetchedText url={att.url} limit={700} />
        </button>
      ) : (
        <button type="button" className="file-chip" onClick={() => onOpen(att)}>
          {att.original_name}
        </button>
      )}
      {onRemove ? (
        <button
          type="button"
          className="thumb-remove"
          aria-label={`Remove ${att.original_name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      ) : null}
      {menu ? (
        <div
          className="color-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 160), top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              downloadAttachment(att);
              setMenu(null);
            }}
          >
            Download
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function LightboxOverlay({
  lightbox,
  onClose,
}: {
  lightbox: Lightbox;
  onClose: () => void;
}) {
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        {lightbox.kind === "image" ? <img src={lightbox.url} alt={lightbox.name} /> : null}
        {lightbox.kind === "pdf" ? (
          <iframe title={lightbox.name} src={lightbox.url} className="lightbox-pdf" />
        ) : null}
        {lightbox.kind === "text" ? <FetchedText url={lightbox.url} /> : null}
        {lightbox.kind === "file" ? (
          <a className="btn" href={lightbox.url} target="_blank" rel="noopener noreferrer">
            Download {lightbox.name}
          </a>
        ) : null}
        {lightbox.kind !== "file" ? (
          <a className="lightbox-name" href={lightbox.url} target="_blank" rel="noopener noreferrer">
            {lightbox.name}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function ItemCard({
  item,
  buckets,
  isStep,
  depth = 0,
  folded = false,
  focused = false,
  foldable = false,
  allView,
  allowReorder = true,
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
  moveTargets,
  onToggle,
  onMove,
  onReparent,
  onRemove,
  onToggleFold,
  onDragStart,
  onDragEnd,
  onCardMouseDown,
  onCardDragOver,
  onCardDragLeave,
  onCardDrop,
  onEditStart,
  onEditTitle,
  onEditNotes,
  onEditDue,
  onEditLead,
  onEditRecur,
  onEditRecurN,
  onEditRecurUnit,
  onEditSave,
  onEditCancel,
  onEditKey,
  onAddStep,
  onStepText,
  onStepKey,
  onStepSave,
  onStepCancel,
  onLightbox,
  onAttach,
  onDetach,
  onSendRemarkable,
  onLater,
  remarkableConfigured = false,
  compact = false,
  compactShowNotes = false,
}: CardProps) {
  const editing = editingId === item.id;
  const bucket = buckets.find((b) => b.id === item.bucket_id);
  const stepCount = countSteps(item);
  const repeat = recurLabel(item);
  const showNotes = Boolean(item.notes) && (!compact || compactShowNotes);
  const [actionMenu, setActionMenu] = useState<ActionMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const classes = [
    "card",
    compact ? "compact" : "",
    item.status === "done" ? "done" : "",
    isStep ? "step" : "",
    draggingId === item.id ? "dragging" : "",
    allowReorder && dropItemId === item.id ? "drop-before" : "",
    dropFileItemId === item.id ? "file-over" : "",
    focused ? "flash" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const cardStyle: { [key: string]: string } = {};
  if (depth > 0) cardStyle["--depth"] = String(depth);
  if (allView && bucket) {
    cardStyle.background = `color-mix(in srgb, ${bucket.color} 28%, var(--bg-card))`;
  }

  useEffect(() => {
    if (!actionMenu) return;
    function close() {
      setActionMenu(null);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onContext() {
      close();
    }
    const timer = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", onContext, true);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [actionMenu]);

  useLayoutEffect(() => {
    if (!actionMenu || !menuRef.current) return;
    const el = menuRef.current;
    const { width, height } = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if (actionMenu.kind === "cursor") {
      left = actionMenu.x;
      top = actionMenu.y;
      if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
      if (left < 12) left = 12;
      if (top + height > window.innerHeight - 12) {
        top = Math.max(12, actionMenu.y - height);
      }
    } else {
      left = actionMenu.right - width;
      top = actionMenu.bottom + 4;
      if (left < 12) left = 12;
      if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
      if (top + height > window.innerHeight - 12) {
        top = Math.max(12, actionMenu.top - height - 4);
      }
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [actionMenu]);

  const renderActions = () => (
    <>
      {!item.parent_id && !item.plan_task_id ? (
        <select
          value={item.bucket_id}
          onChange={(e) => onMove(item, e.target.value)}
          aria-label="Move to bucket"
        >
          {walkBucketTree(buckets).map(({ bucket: b, depth: bucketDepth }) => (
            <option key={b.id} value={b.id}>
              {bucketOptionLabel(b, bucketDepth)}
            </option>
          ))}
        </select>
      ) : null}
      {allowReorder && (item.parent_id || moveTargets.length > 0) ? (
        <select
          value=""
          aria-label="Move under"
          onChange={(e) => {
            const value = e.target.value;
            if (value === "top") onReparent(item, null);
            else if (value) onReparent(item, value);
          }}
        >
          <option value="" disabled>
            Move under…
          </option>
          {item.parent_id ? <option value="top">Top level</option> : null}
          {moveTargets.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
      ) : null}
      {!editing ? (
        <button
          className="btn ghost small"
          onClick={() => {
            setActionMenu(null);
            onEditStart(item);
          }}
        >
          Edit
        </button>
      ) : null}
      <label className="btn ghost small file-btn">
        Attach
        <input
          type="file"
          multiple
          accept={FILE_ACCEPT}
          aria-label="Attach files"
          onChange={(e) => {
            const chosen = e.target.files;
            if (chosen?.length) onAttach(item, Array.from(chosen));
            e.target.value = "";
          }}
        />
      </label>
      <select
        value=""
        aria-label="Remind in"
        onChange={(e) => {
          const value = e.target.value;
          if (value === "clear") onLater(item, null);
          else if (value) onLater(item, Number(value));
        }}
      >
        <option value="" disabled>
          remind in…
        </option>
        {SNOOZE_OFFSETS.map((row) => (
          <option key={row.minutes} value={String(row.minutes)}>
            {row.label}
          </option>
        ))}
        {item.remind_at ? <option value="clear">Clear</option> : null}
      </select>
      {remarkableConfigured && !item.parent_id ? (
        <button className="btn ghost small" onClick={() => onSendRemarkable(item)}>
          Send to reMarkable
        </button>
      ) : null}
      {addingStepFor !== item.id ? (
        <button
          className="btn ghost small"
          onClick={() => {
            setActionMenu(null);
            onAddStep(item);
          }}
        >
          Add step
        </button>
      ) : null}
      <button
        className="btn ghost small"
        onClick={() => {
          setActionMenu(null);
          onRemove(item);
        }}
      >
        Delete
      </button>
    </>
  );

  function onEditPaste(e: ClipboardEvent<HTMLElement>) {
    if (!editing) return;
    const incoming = filesFromDataTransfer(e.clipboardData);
    if (!incoming.length) return;
    e.preventDefault();
    onAttach(item, incoming);
  }

  return (
    <article
      id={`item-${item.id}`}
      className={classes}
      style={cardStyle}
      draggable={allowReorder && dragReadyId === item.id && !editing}
      onMouseDown={(e) => onCardMouseDown(e, item)}
      onDragStart={(e) => onDragStart(e, item)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onCardDragOver(e, item)}
      onDragLeave={(e) => onCardDragLeave(e, item)}
      onDrop={(e) => onCardDrop(e, item)}
      onPaste={(e) => onEditPaste(e)}
      onContextMenu={(e) => {
        const el = e.target as HTMLElement | null;
        if (el?.closest?.(CONTEXT_SKIP_SEL)) return;
        e.preventDefault();
        setActionMenu({ kind: "cursor", x: e.clientX, y: e.clientY });
      }}
      onDoubleClick={(e) => {
        if (editing) return;
        const el = e.target as HTMLElement | null;
        if (el?.closest?.(EDIT_SKIP_SEL)) return;
        e.preventDefault();
        onEditStart(item);
      }}
    >
      {foldable ? (
        <button
          type="button"
          className="fold-btn"
          aria-expanded={!folded}
          aria-label={folded ? "Unfold steps" : "Fold steps"}
          onClick={() => onToggleFold(item)}
        >
          {folded ? "▸" : "▾"}
        </button>
      ) : (
        <span className="fold-spacer" />
      )}
      <button
        className={`check${item.status === "done" ? " done" : ""}`}
        onClick={() => onToggle(item)}
        aria-label={item.status === "done" ? "Mark open" : "Mark done"}
      >
        {item.status === "done" ? "✓" : ""}
      </button>
      <div>
        {editing ? (
          <div className="edit-fields">
            <AutoGrowTextarea
              autoFocus
              value={editTitle}
              placeholder="Title"
              onChange={(e) => onEditTitle(e.target.value)}
              onKeyDown={onEditKey}
            />
            <AutoGrowTextarea
              value={editNotes}
              placeholder="Notes"
              onChange={(e) => onEditNotes(e.target.value)}
              onKeyDown={onEditKey}
            />
            <div className="due-row">
              <label>
                Due
                <input
                  type="datetime-local"
                  value={editDue}
                  onChange={(e) => {
                    onEditDue(e.target.value);
                    if (!e.target.value) {
                      onEditLead("");
                      onEditRecur("");
                    }
                  }}
                />
              </label>
              <label>
                Reminder
                <select
                  value={editLead}
                  disabled={!editDue}
                  onChange={(e) => onEditLead(e.target.value)}
                  aria-label="Remind before due"
                >
                  <option value="">None</option>
                  {REMINDER_LEADS.map((lead) => (
                    <option key={lead.minutes} value={String(lead.minutes)}>
                      {lead.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Repeat
                <select
                  value={editRecur}
                  disabled={!editDue}
                  onChange={(e) => onEditRecur(e.target.value)}
                  aria-label="Repeat"
                >
                  <option value="">None</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {editRecur === "custom" ? (
                <label className="recur-custom">
                  Every
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={editRecurN}
                    disabled={!editDue}
                    onChange={(e) => onEditRecurN(e.target.value)}
                    aria-label="Repeat every"
                  />
                  <select
                    value={editRecurUnit}
                    disabled={!editDue}
                    onChange={(e) => onEditRecurUnit(e.target.value === "week" ? "week" : "day")}
                    aria-label="Repeat unit"
                  >
                    <option value="day">days</option>
                    <option value="week">weeks</option>
                  </select>
                </label>
              ) : null}
            </div>
            <div className="composer-row">
              <button className="btn small" type="button" onClick={onEditSave}>
                Save
              </button>
              <button className="btn ghost small" type="button" onClick={onEditCancel}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {item.title ? <div className="title">{formatRichText(item.title)}</div> : null}
            {showNotes && item.notes ? <div className="notes">{formatRichText(item.notes)}</div> : null}
            {!item.title && !item.notes && item.attachments.length === 0 ? (
              <p className="title">Untitled</p>
            ) : null}
          </>
        )}
        {item.attachments.length > 0 ? (
          <div className={`thumbs${item.title ? "" : " photo-item"}`}>
            {item.attachments.map((att) => (
              <AttachmentBlock
                key={att.id}
                att={att}
                onOpen={onLightbox}
                onRemove={() => onDetach(item, att.id)}
              />
            ))}
          </div>
        ) : null}
        <div className="meta">
          <span>{relativeTime(item.created_at)}</span>
          <span>{item.source}</span>
          {allView && bucket ? (
            <span className="bucket-tag">
              <span className="dot" style={{ background: bucket.color }} />
              {bucket.name}
            </span>
          ) : null}
          {(() => {
            const due = dueMeta(item);
            if (!due) return null;
            return <span className={`due ${due.kind}`}>{due.text}</span>;
          })()}
          {repeat ? <span className="nudge">{repeat}</span> : null}
          {item.remind_at ? (
            <span className="nudge">remind {formatDueStamp(item.remind_at)}</span>
          ) : null}
          {folded && stepCount ? (
            <span className="step-count">
              {stepCount} {stepCount === 1 ? "step" : "steps"}
            </span>
          ) : null}
        </div>
        {addingStepFor === item.id ? (
          <form
            className="step-form"
            onSubmit={(e) => {
              e.preventDefault();
              onStepSave(item);
            }}
          >
            <textarea
              autoFocus
              rows={1}
              placeholder="Next step…"
              value={stepText}
              onChange={(e) => onStepText(e.target.value)}
              onKeyDown={(e) => onStepKey(e, item)}
            />
            <button className="btn small" type="submit" disabled={!stepText.trim()}>
              Add
            </button>
            <button className="btn ghost small" type="button" onClick={onStepCancel}>
              Cancel
            </button>
          </form>
        ) : null}
      </div>
      <div className="card-actions">
        {compact ? (
          <button
            type="button"
            className="card-more"
            aria-label="More actions"
            aria-expanded={Boolean(actionMenu)}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (actionMenu) {
                setActionMenu(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setActionMenu({ kind: "button", right: rect.right, top: rect.top, bottom: rect.bottom });
            }}
          >
            <span aria-hidden="true">☰</span>
          </button>
        ) : (
          renderActions()
        )}
      </div>
      {actionMenu ? (
        <div
          ref={menuRef}
          className="color-menu card-action-menu"
          style={
            actionMenu.kind === "cursor"
              ? { left: actionMenu.x, top: actionMenu.y }
              : { left: actionMenu.right - 220, top: actionMenu.bottom + 4 }
          }
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {renderActions()}
        </div>
      ) : null}
    </article>
  );
}

export function TreeCards({ item, depth, viewDone, folded, focusId, cardProps }: TreeCardProps) {
  const { items: treeItems, ...restCard } = cardProps;
  const kids = item.subtasks ?? [];
  const collapsed = folded.has(item.id);
  const targets = restCard.allowReorder === false ? [] : moveOptions(treeItems, item);
  return (
    <>
      <ItemCard
        {...restCard}
        item={item}
        depth={depth}
        isStep={depth > 0 || Boolean(viewDone && item.parent_id)}
        folded={collapsed}
        focused={focusId === item.id}
        foldable={!viewDone && kids.length > 0}
        moveTargets={targets}
      />
      {!viewDone && !collapsed
        ? kids.map((step) => (
            <TreeCards
              key={step.id}
              item={step}
              depth={depth + 1}
              viewDone={viewDone}
              folded={folded}
              focusId={focusId}
              cardProps={cardProps}
            />
          ))
        : null}
    </>
  );
}
