from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.buckets import (
    bucket_locked,
    inclusive_open_counts,
    next_sibling_sort,
    user_buckets,
    would_cycle,
)
from app.database import get_db
from app.deps import require_licensed
from app.models import Bucket, Item, User
from app.schemas import BucketIn, BucketOut, BucketUpdate, ReorderIn
from app.security import validate_color

router = APIRouter(prefix="/api/buckets", tags=["buckets"])


def _direct_open_counts(db: Session, user_id: str) -> dict[str, int]:
    rows = db.execute(
        select(Item.bucket_id, func.count())
        .where(Item.user_id == user_id, Item.status == "open")
        .group_by(Item.bucket_id)
    ).all()
    return {bucket_id: count for bucket_id, count in rows}


def _to_out(bucket: Bucket, counts: dict[str, int]) -> BucketOut:
    return BucketOut(
        id=bucket.id,
        name=bucket.name,
        color=bucket.color,
        sort_order=bucket.sort_order,
        is_inbox=bucket.is_inbox,
        parent_id=bucket.parent_id,
        organization_id=bucket.organization_id,
        plan_project_id=bucket.plan_project_id,
        locked=bucket_locked(bucket),
        open_count=counts.get(bucket.id, 0),
    )


def _counts_for(db: Session, user_id: str, buckets: list[Bucket] | None = None) -> dict[str, int]:
    rows = buckets if buckets is not None else user_buckets(db, user_id)
    return inclusive_open_counts(_direct_open_counts(db, user_id), rows)


@router.get("", response_model=list[BucketOut])
def list_buckets(user: User = Depends(require_licensed), db: Session = Depends(get_db)):
    buckets = user_buckets(db, user.id)
    counts = _counts_for(db, user.id, buckets)
    return [_to_out(b, counts) for b in buckets]


@router.post("", response_model=BucketOut)
def create_bucket(
    body: BucketIn,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    color = validate_color(body.color)
    parent_id = body.parent_id
    if parent_id:
        parent = db.get(Bucket, parent_id)
        if parent is None or parent.user_id != user.id:
            raise HTTPException(status_code=404, detail="Parent bucket not found")
    bucket = Bucket(
        user_id=user.id,
        name=body.name.strip(),
        color=color,
        sort_order=next_sibling_sort(db, user.id, parent_id),
        is_inbox=False,
        parent_id=parent_id,
    )
    db.add(bucket)
    db.commit()
    db.refresh(bucket)
    return _to_out(bucket, _counts_for(db, user.id))


@router.post("/reorder")
def reorder_buckets(
    body: ReorderIn,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    loaded: list[Bucket] = []
    for bucket_id in body.ids:
        bucket = db.get(Bucket, bucket_id)
        if bucket is None or bucket.user_id != user.id:
            raise HTTPException(status_code=404, detail="Bucket not found")
        loaded.append(bucket)
    parent_ids = {row.parent_id for row in loaded}
    if len(parent_ids) > 1:
        raise HTTPException(status_code=400, detail="Can only reorder buckets at the same level")
    for index, bucket in enumerate(loaded):
        bucket.sort_order = index
    db.commit()
    return {"ok": True}


@router.patch("/{bucket_id}", response_model=BucketOut)
def update_bucket(
    bucket_id: str,
    body: BucketUpdate,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    bucket = db.get(Bucket, bucket_id)
    if bucket is None or bucket.user_id != user.id:
        raise HTTPException(status_code=404, detail="Bucket not found")
    locked = bucket_locked(bucket)
    if body.name is not None:
        if bucket.is_inbox:
            raise HTTPException(status_code=400, detail="Inbox cannot be renamed")
        if locked:
            raise HTTPException(status_code=400, detail="Organization and project buckets cannot be renamed")
        bucket.name = body.name.strip()
    if body.color is not None:
        bucket.color = validate_color(body.color)
    if body.sort_order is not None:
        bucket.sort_order = body.sort_order
    if "parent_id" in body.model_fields_set:
        parent_id = body.parent_id
        if parent_id == bucket.id:
            raise HTTPException(status_code=400, detail="A bucket cannot contain itself")
        if bucket.is_inbox and parent_id:
            raise HTTPException(status_code=400, detail="Inbox cannot be nested")
        if locked:
            raise HTTPException(status_code=400, detail="Organization and project buckets cannot be moved")
        if parent_id:
            parent = db.get(Bucket, parent_id)
            if parent is None or parent.user_id != user.id:
                raise HTTPException(status_code=404, detail="Parent bucket not found")
            owned = user_buckets(db, user.id)
            if would_cycle(owned, bucket.id, parent_id):
                raise HTTPException(status_code=400, detail="That would nest a bucket inside itself")
        if parent_id != bucket.parent_id:
            bucket.parent_id = parent_id
            bucket.sort_order = next_sibling_sort(db, user.id, parent_id)
    db.commit()
    db.refresh(bucket)
    return _to_out(bucket, _counts_for(db, user.id))


@router.delete("/{bucket_id}")
def delete_bucket(
    bucket_id: str,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    bucket = db.get(Bucket, bucket_id)
    if bucket is None or bucket.user_id != user.id:
        raise HTTPException(status_code=404, detail="Bucket not found")
    if bucket.is_inbox:
        raise HTTPException(status_code=400, detail="Inbox cannot be deleted")
    if bucket_locked(bucket):
        raise HTTPException(status_code=400, detail="Organization and project buckets cannot be deleted")
    inbox = db.scalar(
        select(Bucket).where(Bucket.user_id == user.id, Bucket.is_inbox.is_(True))
    )
    if inbox is None:
        raise HTTPException(status_code=500, detail="Inbox missing")
    db.execute(update(Item).where(Item.bucket_id == bucket.id).values(bucket_id=inbox.id))
    children = list(db.scalars(select(Bucket).where(Bucket.parent_id == bucket.id)).all())
    adopt_parent = bucket.parent_id
    start = next_sibling_sort(db, user.id, adopt_parent)
    for index, child in enumerate(children):
        child.parent_id = adopt_parent
        child.sort_order = start + index
    db.expire(bucket, ["items"])
    db.delete(bucket)
    db.commit()
    return {"ok": True}
