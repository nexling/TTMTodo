import calendar
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.buckets import descendant_ids, user_buckets
from app.config import settings
from app.database import get_db
from app.deps import require_licensed
from app.models import Attachment, Bucket, Item, User
from app.schemas import (
    MAX_NEST_DEPTH,
    REMINDER_LEAD_MINUTES,
    RECUR_UNITS,
    AttachmentOut,
    ItemOut,
    ItemUpdate,
    ReorderIn,
)
from app.security import read_upload, store_upload

router = APIRouter(prefix="/api/items", tags=["items"])


def attachment_out(att: Attachment) -> AttachmentOut:
    return AttachmentOut(
        id=att.id,
        original_name=att.original_name,
        mime_type=att.mime_type,
        size=att.size,
        url=f"/api/files/{att.id}",
    )


def _utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def item_out(item: Item, subtasks: list[ItemOut] | None = None) -> ItemOut:
    return ItemOut(
        id=item.id,
        bucket_id=item.bucket_id,
        parent_id=item.parent_id,
        title=item.title,
        notes=item.notes,
        status=item.status,
        source=item.source,
        created_at=_utc(item.created_at) or datetime.now(timezone.utc),
        completed_at=_utc(item.completed_at),
        due_at=_utc(item.due_at),
        reminder_lead_minutes=item.reminder_lead_minutes,
        remind_at=_utc(item.remind_at),
        recur_interval=item.recur_interval,
        recur_unit=item.recur_unit,
        ocr_text=item.ocr_text,
        ai_priority=item.ai_priority,
        ai_summary=item.ai_summary,
        attachments=[attachment_out(a) for a in item.attachments],
        subtasks=list(subtasks or []),
        sort_order=item.sort_order,
        plan_task_id=item.plan_task_id,
    )


def children_map(rows: list[Item]) -> dict[str, list[Item]]:
    grouped: dict[str, list[Item]] = {}
    for row in rows:
        if row.parent_id:
            grouped.setdefault(row.parent_id, []).append(row)
    for kids in grouped.values():
        kids.sort(key=lambda it: (it.sort_order, it.created_at))
    return grouped


def has_open_descendant(item: Item, grouped: dict[str, list[Item]]) -> bool:
    for kid in grouped.get(item.id, []):
        if kid.status == "open" or has_open_descendant(kid, grouped):
            return True
    return False


def nest_item(
    item: Item, grouped: dict[str, list[Item]], *, include_done: bool
) -> ItemOut | None:
    visible = include_done or item.status == "open" or has_open_descendant(item, grouped)
    if not visible:
        return None
    nested: list[ItemOut] = []
    for kid in grouped.get(item.id, []):
        child = nest_item(kid, grouped, include_done=include_done)
        if child is not None:
            nested.append(child)
    return item_out(item, nested)


def add_months(dt: datetime, months: int) -> datetime:
    month = dt.month - 1 + months
    year = dt.year + month // 12
    month = month % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def advance_due(due: datetime, interval: int, unit: str) -> datetime:
    if unit == "day":
        return due + timedelta(days=interval)
    if unit == "week":
        return due + timedelta(weeks=interval)
    if unit == "month":
        return add_months(due, interval)
    if unit == "year":
        return add_months(due, interval * 12)
    raise HTTPException(status_code=400, detail="Invalid recurrence")


def ancestor_depth(db: Session, item: Item) -> int:
    depth = 0
    seen: set[str] = set()
    current = item
    while current.parent_id:
        if current.parent_id in seen or depth >= MAX_NEST_DEPTH:
            break
        seen.add(current.parent_id)
        parent = db.get(Item, current.parent_id)
        if parent is None:
            break
        depth += 1
        current = parent
    return depth


def subtree_height(item: Item, grouped: dict[str, list[Item]]) -> int:
    kids = grouped.get(item.id, [])
    if not kids:
        return 1
    return 1 + max(subtree_height(kid, grouped) for kid in kids)


def would_cycle(db: Session, item_id: str, new_parent: Item) -> bool:
    current: Item | None = new_parent
    seen: set[str] = set()
    while current is not None:
        if current.id == item_id:
            return True
        if current.id in seen:
            break
        seen.add(current.id)
        if not current.parent_id:
            break
        current = db.get(Item, current.parent_id)
    return False


def walk_subtree(db: Session, user: User, item: Item, seen: set[str] | None = None) -> list[Item]:
    seen = seen if seen is not None else set()
    if item.id in seen:
        return []
    seen.add(item.id)
    out = [item]
    for child in load_children(db, user, item.id):
        out.extend(walk_subtree(db, user, child, seen))
    return out


def set_subtree_bucket(db: Session, user: User, item: Item, bucket_id: str) -> None:
    for node in walk_subtree(db, user, item):
        node.bucket_id = bucket_id


def apply_recurrence(item: Item, interval: int | None, unit: str | None) -> None:
    if interval is None and unit is None:
        item.recur_interval = None
        item.recur_unit = None
        return
    if interval is None or unit is None:
        raise HTTPException(status_code=400, detail="Set both recurrence interval and unit")
    if unit not in RECUR_UNITS:
        raise HTTPException(status_code=400, detail="Recurrence must be day, week, month, or year")
    item.recur_interval = interval
    item.recur_unit = unit


def get_owned_bucket(db: Session, user: User, bucket_id: str) -> Bucket:
    bucket = db.get(Bucket, bucket_id)
    if bucket is None or bucket.user_id != user.id:
        raise HTTPException(status_code=404, detail="Bucket not found")
    return bucket


def _is_real_upload(upload: UploadFile | None) -> bool:
    if upload is None:
        return False
    return bool((upload.filename or "").strip())


def collect_uploads(*groups: UploadFile | list[UploadFile] | None) -> list[UploadFile]:
    out: list[UploadFile] = []
    for group in groups:
        if group is None:
            continue
        if isinstance(group, list):
            out.extend(f for f in group if _is_real_upload(f))
        elif _is_real_upload(group):
            out.append(group)
    return out


def add_attachment(db: Session, item: Item, upload: UploadFile) -> Attachment:
    data, mime, ext, original = read_upload(upload)
    stored = store_upload(data, ext)
    att = Attachment(
        item_id=item.id,
        original_name=original,
        stored_name=stored,
        mime_type=mime,
        size=len(data),
    )
    db.add(att)
    return att


def add_attachment_bytes(db: Session, item: Item, data: bytes, filename: str) -> Attachment:
    from tempfile import SpooledTemporaryFile

    from starlette.datastructures import Headers, UploadFile as StarletteUpload

    buf = SpooledTemporaryFile()
    buf.write(data)
    buf.seek(0)
    mime = "image/png" if filename.lower().endswith(".png") else "image/jpeg"
    upload = StarletteUpload(
        file=buf,
        filename=filename,
        headers=Headers({"content-type": mime}),
    )
    return add_attachment(db, item, upload)


def replace_item_image(db: Session, item: Item, data: bytes, filename: str) -> Attachment:
    delete_files(item)
    for att in list(item.attachments):
        db.delete(att)
    db.flush()
    return add_attachment_bytes(db, item, data, filename)


def load_item(db: Session, user: User, item_id: str) -> Item:
    item = db.scalar(
        select(Item)
        .options(selectinload(Item.attachments))
        .where(Item.id == item_id, Item.user_id == user.id)
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


def load_children(db: Session, user: User, parent_id: str) -> list[Item]:
    return list(
        db.scalars(
            select(Item)
            .options(selectinload(Item.attachments))
            .where(Item.user_id == user.id, Item.parent_id == parent_id)
            .order_by(Item.sort_order.asc(), Item.created_at.asc())
        ).all()
    )


def item_out_with_children(db: Session, user: User, item: Item) -> ItemOut:
    rows = list(
        db.scalars(
            select(Item)
            .options(selectinload(Item.attachments))
            .where(Item.user_id == user.id)
        ).all()
    )
    grouped = children_map(rows)
    nested = nest_item(item, grouped, include_done=True)
    return nested if nested is not None else item_out(item)


def delete_files(item: Item) -> None:
    for att in list(item.attachments):
        path = settings.upload_dir / att.stored_name
        if path.is_file():
            path.unlink()


def sibling_filter(user_id: str, bucket_id: str, parent_id: str | None):
    clauses = [Item.user_id == user_id, Item.bucket_id == bucket_id]
    if parent_id:
        clauses.append(Item.parent_id == parent_id)
    else:
        clauses.append(Item.parent_id.is_(None))
    return clauses


def next_sort_order(
    db: Session, user: User, bucket_id: str, parent_id: str | None, *, prepend: bool
) -> int:
    col = func.min(Item.sort_order) if prepend else func.max(Item.sort_order)
    val = db.scalar(select(col).where(*sibling_filter(user.id, bucket_id, parent_id)))
    if val is None:
        return 0
    return val - 1 if prepend else val + 1


@router.get("", response_model=list[ItemOut])
def list_items(
    bucket_id: str | None = None,
    include_done: bool = False,
    include_descendants: bool = False,
    completed_since: datetime | None = None,
    completed_before: datetime | None = None,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    query = (
        select(Item)
        .options(selectinload(Item.attachments))
        .where(Item.user_id == user.id)
    )
    if completed_since is not None:
        since = _utc(completed_since)
        if since is not None and since.tzinfo is not None:
            since = since.astimezone(timezone.utc).replace(tzinfo=None)
        query = query.where(Item.status == "done", Item.completed_at >= since)
        if completed_before is not None:
            before = _utc(completed_before)
            if before is not None and before.tzinfo is not None:
                before = before.astimezone(timezone.utc).replace(tzinfo=None)
            if before is not None:
                query = query.where(Item.completed_at < before)
        rows = list(db.scalars(query).all())

        def completed_key(it: Item) -> float:
            stamp = _utc(it.completed_at) or _utc(it.created_at)
            return stamp.timestamp() if stamp else 0.0

        rows.sort(key=completed_key, reverse=True)
        return [item_out(row) for row in rows]
    if bucket_id:
        get_owned_bucket(db, user, bucket_id)
        if include_descendants:
            ids = {bucket_id} | descendant_ids(user_buckets(db, user.id), bucket_id)
            query = query.where(Item.bucket_id.in_(ids))
        else:
            query = query.where(Item.bucket_id == bucket_id)
    rows = list(db.scalars(query).all())
    grouped = children_map(rows)
    tops = [row for row in rows if row.parent_id is None]
    tops.sort(key=lambda it: (it.sort_order, -it.created_at.timestamp()))
    out: list[ItemOut] = []
    for parent in tops:
        nested = nest_item(parent, grouped, include_done=include_done)
        if nested is not None:
            out.append(nested)
    return out


@router.post("", response_model=ItemOut)
async def create_item(
    title: str | None = Form(default=None),
    notes: str | None = Form(default=None),
    bucket_id: str | None = Form(default=None),
    parent_id: str | None = Form(default=None),
    source: str = Form(default="web"),
    due_at: datetime | None = Form(default=None),
    image: UploadFile | None = File(default=None),
    files: list[UploadFile] | None = File(default=None),
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    clean_title = (title or "").strip() or None
    clean_notes = (notes or "").strip() or None
    uploads = collect_uploads(image, files)
    if not clean_title and not clean_notes and not uploads:
        raise HTTPException(status_code=400, detail="Add text or a file")

    parent = None
    if parent_id:
        parent = load_item(db, user, parent_id)
        if ancestor_depth(db, parent) + 1 >= MAX_NEST_DEPTH:
            raise HTTPException(status_code=400, detail="Too many nested steps")
        bucket = get_owned_bucket(db, user, parent.bucket_id)
    elif bucket_id:
        bucket = get_owned_bucket(db, user, bucket_id)
    else:
        bucket = db.scalar(
            select(Bucket).where(Bucket.user_id == user.id, Bucket.is_inbox.is_(True))
        )
        if bucket is None:
            raise HTTPException(status_code=500, detail="Inbox missing")

    src = (source or "web").strip()[:32] or "web"
    item = Item(
        user_id=user.id,
        bucket_id=bucket.id,
        parent_id=parent.id if parent else None,
        title=clean_title[:500] if clean_title else None,
        notes=clean_notes,
        source=src,
        status="open",
        due_at=_utc(due_at),
        sort_order=next_sort_order(
            db, user, bucket.id, parent.id if parent else None, prepend=parent is None
        ),
    )
    db.add(item)
    db.flush()
    for upload in uploads:
        add_attachment(db, item, upload)
    db.commit()
    loaded = load_item(db, user, item.id)
    return item_out_with_children(db, user, loaded)


@router.post("/reorder")
def reorder_items(
    body: ReorderIn,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    loaded = [load_item(db, user, item_id) for item_id in body.ids]
    parent_id = loaded[0].parent_id
    bucket_id = loaded[0].bucket_id
    if any(it.parent_id != parent_id or it.bucket_id != bucket_id for it in loaded):
        raise HTTPException(status_code=400, detail="Items must be in the same list")
    for index, it in enumerate(loaded):
        it.sort_order = index
    rest = [
        row
        for row in db.scalars(
            select(Item).where(*sibling_filter(user.id, bucket_id, parent_id)).order_by(
                Item.sort_order, Item.created_at
            )
        ).all()
        if row.id not in set(body.ids)
    ]
    for extra, row in enumerate(rest, start=len(loaded)):
        row.sort_order = extra
    db.commit()
    return {"ok": True}


@router.get("/{item_id}", response_model=ItemOut)
def get_item(item_id: str, user: User = Depends(require_licensed), db: Session = Depends(get_db)):
    item = load_item(db, user, item_id)
    return item_out_with_children(db, user, item)


@router.patch("/{item_id}", response_model=ItemOut)
def update_item(
    item_id: str,
    body: ItemUpdate,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    item = load_item(db, user, item_id)
    fields = body.model_fields_set
    if body.title is not None:
        item.title = body.title.strip() or None
    if body.notes is not None:
        item.notes = body.notes.strip() or None
    if "parent_id" in fields:
        new_parent_id = body.parent_id
        if new_parent_id == item.id:
            raise HTTPException(status_code=400, detail="A task cannot be nested under itself")
        dest_parent: Item | None = None
        dest_bucket_id = item.bucket_id
        if new_parent_id:
            dest_parent = load_item(db, user, new_parent_id)
            if would_cycle(db, item.id, dest_parent):
                raise HTTPException(status_code=400, detail="Cannot nest a task under its own step")
            rows = list(
                db.scalars(select(Item).where(Item.user_id == user.id)).all()
            )
            grouped = children_map(rows)
            if ancestor_depth(db, dest_parent) + subtree_height(item, grouped) >= MAX_NEST_DEPTH:
                raise HTTPException(status_code=400, detail="Too many nested steps")
            dest_bucket_id = dest_parent.bucket_id
        dest_parent_id = dest_parent.id if dest_parent else None
        if item.plan_task_id and dest_bucket_id != item.bucket_id:
            raise HTTPException(status_code=400, detail="Project tasks stay in their project folder")
        if dest_parent_id != item.parent_id or dest_bucket_id != item.bucket_id:
            new_order = next_sort_order(
                db, user, dest_bucket_id, dest_parent_id, prepend=dest_parent is None
            )
            item.parent_id = dest_parent_id
            set_subtree_bucket(db, user, item, dest_bucket_id)
            item.sort_order = new_order
    elif body.bucket_id is not None:
        if item.plan_task_id and body.bucket_id != item.bucket_id:
            raise HTTPException(status_code=400, detail="Project tasks stay in their project folder")
        get_owned_bucket(db, user, body.bucket_id)
        if item.parent_id is None:
            item.sort_order = next_sort_order(db, user, body.bucket_id, None, prepend=True)
            set_subtree_bucket(db, user, item, body.bucket_id)
        else:
            item.bucket_id = body.bucket_id
    if "due_at" in fields:
        item.due_at = _utc(body.due_at)
        if item.plan_task_id:
            from app.plan import apply_item_due_to_plan

            apply_item_due_to_plan(db, item)
    if "reminder_lead_minutes" in fields:
        lead = body.reminder_lead_minutes
        if lead is not None and lead not in REMINDER_LEAD_MINUTES:
            raise HTTPException(
                status_code=400,
                detail="Reminder must be 15 minutes, 1 hour, 1 day, 2 days, 3 days, or 1 week",
            )
        item.reminder_lead_minutes = lead
    if "recur_interval" in fields or "recur_unit" in fields:
        interval = body.recur_interval if "recur_interval" in fields else item.recur_interval
        unit = body.recur_unit if "recur_unit" in fields else item.recur_unit
        apply_recurrence(item, interval, unit)
    if item.due_at is None:
        if (
            "reminder_lead_minutes" in fields
            and body.reminder_lead_minutes is not None
            and "due_at" not in fields
        ):
            raise HTTPException(status_code=400, detail="Set a due time before a reminder")
        item.reminder_lead_minutes = None
        item.recur_interval = None
        item.recur_unit = None
    elif item.recur_interval or item.recur_unit:
        if not item.recur_interval or not item.recur_unit:
            raise HTTPException(status_code=400, detail="Set both recurrence interval and unit")
        if item.due_at is None:
            raise HTTPException(status_code=400, detail="Set a due time before recurrence")
    if "remind_at" in fields:
        item.remind_at = _utc(body.remind_at)
    if body.status is not None:
        if item.plan_task_id:
            from app.plan import apply_item_status_to_plan

            apply_item_status_to_plan(db, item, body.status)
        if (
            body.status == "done"
            and item.recur_interval
            and item.recur_unit
            and item.due_at is not None
            and not item.plan_task_id
        ):
            item.due_at = advance_due(item.due_at, item.recur_interval, item.recur_unit)
            item.remind_at = None
            item.status = "open"
            item.completed_at = None
        else:
            item.status = body.status
            item.completed_at = datetime.now(timezone.utc) if body.status == "done" else None
    db.commit()
    loaded = load_item(db, user, item.id)
    return item_out_with_children(db, user, loaded)


@router.delete("/{item_id}")
def delete_item(item_id: str, user: User = Depends(require_licensed), db: Session = Depends(get_db)):
    item = load_item(db, user, item_id)
    if item.plan_task_id:
        from app.models import PlanTask

        task = db.get(PlanTask, item.plan_task_id)
        if task is not None:
            task.item_id = None
        item.plan_task_id = None
    for node in walk_subtree(db, user, item):
        delete_files(node)
    db.delete(item)
    db.commit()
    return {"ok": True}


@router.post("/{item_id}/attachments", response_model=ItemOut)
async def add_item_attachment(
    item_id: str,
    image: UploadFile | None = File(default=None),
    file: UploadFile | None = File(default=None),
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    item = load_item(db, user, item_id)
    uploads = collect_uploads(file, image)
    if not uploads:
        raise HTTPException(status_code=400, detail="Choose a file")
    for upload in uploads:
        add_attachment(db, item, upload)
    db.commit()
    loaded = load_item(db, user, item.id)
    return item_out_with_children(db, user, loaded)


@router.delete("/{item_id}/attachments/{attachment_id}")
def delete_attachment(
    item_id: str,
    attachment_id: str,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    item = load_item(db, user, item_id)
    att = next((a for a in item.attachments if a.id == attachment_id), None)
    if att is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    path = settings.upload_dir / att.stored_name
    if path.is_file():
        path.unlink()
    db.delete(att)
    db.commit()
    return {"ok": True}
