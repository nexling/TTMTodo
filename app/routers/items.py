from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.buckets import descendant_ids, user_buckets
from app.database import get_db
from app.deps import require_scope
from app.items import (
    attach_uploads,
    children_map,
    collect_uploads,
    create_item,
    delete_item,
    detach_attachment,
    get_owned_bucket,
    item_out,
    item_out_with_children,
    load_item,
    nest_item,
    sibling_filter,
    update_item,
    utc,
)
from app.models import Item, User
from app.schemas import ItemCreate, ItemOut, ItemUpdate, ReorderIn

router = APIRouter(prefix="/api/items", tags=["items"])

CREATE_DESCRIPTION = (
    "JSON for text fields (default source=api). "
    "multipart/form-data for files (title, notes, bucket_id, parent_id, source, due_at, image, files)."
)


@router.get("", response_model=list[ItemOut])
def list_items(
    bucket_id: str | None = None,
    include_done: bool = False,
    include_descendants: bool = False,
    completed_since: datetime | None = None,
    completed_before: datetime | None = None,
    user: User = Depends(require_scope("items")),
    db: Session = Depends(get_db),
):
    query = (
        select(Item)
        .options(selectinload(Item.attachments))
        .where(Item.user_id == user.id)
    )
    if completed_since is not None:
        since = utc(completed_since)
        if since is not None and since.tzinfo is not None:
            since = since.astimezone(timezone.utc).replace(tzinfo=None)
        query = query.where(Item.status == "done", Item.completed_at >= since)
        if completed_before is not None:
            before = utc(completed_before)
            if before is not None and before.tzinfo is not None:
                before = before.astimezone(timezone.utc).replace(tzinfo=None)
            if before is not None:
                query = query.where(Item.completed_at < before)
        rows = list(db.scalars(query).all())

        def completed_key(it: Item) -> float:
            stamp = utc(it.completed_at) or utc(it.created_at)
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


@router.post(
    "",
    response_model=ItemOut,
    summary="Create an item",
    description=CREATE_DESCRIPTION,
    openapi_extra={
        "requestBody": {
            "content": {
                "application/json": {"schema": ItemCreate.model_json_schema()},
            }
        }
    },
)
async def create_item_route(
    request: Request,
    user: User = Depends(require_scope("items")),
    db: Session = Depends(get_db),
):
    ctype = (request.headers.get("content-type") or "").lower()
    uploads: list[UploadFile] = []
    if "application/json" in ctype:
        try:
            body = ItemCreate.model_validate(await request.json())
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=exc.errors()) from exc
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc
        item = create_item(
            db,
            user,
            title=body.title,
            notes=body.notes,
            bucket_id=body.bucket_id,
            parent_id=body.parent_id,
            source=(body.source or "api"),
            due_at=body.due_at,
        )
    else:
        form = await request.form()
        raw_title = form.get("title")
        raw_notes = form.get("notes")
        raw_bucket = form.get("bucket_id")
        raw_parent = form.get("parent_id")
        raw_source = form.get("source")
        raw_due = form.get("due_at")
        title = raw_title.strip() if isinstance(raw_title, str) else None
        notes = raw_notes.strip() if isinstance(raw_notes, str) else None
        bucket_id = raw_bucket.strip() if isinstance(raw_bucket, str) and raw_bucket.strip() else None
        parent_id = raw_parent.strip() if isinstance(raw_parent, str) and raw_parent.strip() else None
        source = raw_source.strip() if isinstance(raw_source, str) and raw_source.strip() else "web"
        due_at = None
        if isinstance(raw_due, str) and raw_due.strip():
            try:
                due_at = datetime.fromisoformat(raw_due.strip().replace("Z", "+00:00"))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Invalid due_at") from exc
        uploads = collect_uploads(form.get("image"), form.getlist("files"), form.getlist("file"))
        item = create_item(
            db,
            user,
            title=title,
            notes=notes,
            bucket_id=bucket_id,
            parent_id=parent_id,
            source=source,
            due_at=due_at,
            uploads=uploads,
        )
    db.commit()
    loaded = load_item(db, user, item.id)
    return item_out_with_children(db, user, loaded)


@router.post("/reorder")
def reorder_items(
    body: ReorderIn,
    user: User = Depends(require_scope("items")),
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
def get_item(item_id: str, user: User = Depends(require_scope("items")), db: Session = Depends(get_db)):
    item = load_item(db, user, item_id)
    return item_out_with_children(db, user, item)


@router.patch("/{item_id}", response_model=ItemOut)
def patch_item(
    item_id: str,
    body: ItemUpdate,
    user: User = Depends(require_scope("items")),
    db: Session = Depends(get_db),
):
    item = load_item(db, user, item_id)
    update_item(db, user, item, body)
    db.commit()
    loaded = load_item(db, user, item.id)
    return item_out_with_children(db, user, loaded)


@router.delete("/{item_id}")
def remove_item(item_id: str, user: User = Depends(require_scope("items")), db: Session = Depends(get_db)):
    item = load_item(db, user, item_id)
    delete_item(db, user, item)
    db.commit()
    return {"ok": True}


@router.post("/{item_id}/attachments", response_model=ItemOut)
async def add_item_attachment(
    item_id: str,
    image: UploadFile | None = File(default=None),
    file: UploadFile | None = File(default=None),
    user: User = Depends(require_scope("items")),
    db: Session = Depends(get_db),
):
    item = load_item(db, user, item_id)
    attach_uploads(db, item, collect_uploads(file, image))
    db.commit()
    loaded = load_item(db, user, item.id)
    return item_out_with_children(db, user, loaded)


@router.delete("/{item_id}/attachments/{attachment_id}")
def delete_attachment(
    item_id: str,
    attachment_id: str,
    user: User = Depends(require_scope("items")),
    db: Session = Depends(get_db),
):
    item = load_item(db, user, item_id)
    detach_attachment(db, item, attachment_id)
    db.commit()
    return {"ok": True}
