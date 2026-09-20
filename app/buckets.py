from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Bucket, Organization, PlanProject


def bucket_locked(bucket: Bucket) -> bool:
    return bool(bucket.organization_id or bucket.plan_project_id)


def sibling_parent_key(parent_id: str | None) -> str | None:
    return parent_id or None


def children_map(buckets: list[Bucket]) -> dict[str | None, list[Bucket]]:
    grouped: dict[str | None, list[Bucket]] = {}
    for bucket in buckets:
        grouped.setdefault(sibling_parent_key(bucket.parent_id), []).append(bucket)
    for rows in grouped.values():
        rows.sort(key=lambda row: (row.sort_order, row.created_at or 0, row.name))
    return grouped


def descendant_ids(buckets: list[Bucket], root_id: str) -> set[str]:
    grouped = children_map(buckets)
    found: set[str] = set()
    stack = [root_id]
    while stack:
        current = stack.pop()
        for child in grouped.get(current, []):
            if child.id in found:
                continue
            found.add(child.id)
            stack.append(child.id)
    return found


def would_cycle(buckets: list[Bucket], bucket_id: str, new_parent_id: str | None) -> bool:
    if not new_parent_id:
        return False
    if new_parent_id == bucket_id:
        return True
    return new_parent_id in descendant_ids(buckets, bucket_id)


def inclusive_open_counts(direct: dict[str, int], buckets: list[Bucket]) -> dict[str, int]:
    grouped = children_map(buckets)
    memo: dict[str, int] = {}

    def total(bucket_id: str) -> int:
        if bucket_id in memo:
            return memo[bucket_id]
        value = direct.get(bucket_id, 0)
        for child in grouped.get(bucket_id, []):
            value += total(child.id)
        memo[bucket_id] = value
        return value

    return {bucket.id: total(bucket.id) for bucket in buckets}


def next_sibling_sort(db: Session, user_id: str, parent_id: str | None) -> int:
    query = select(func.max(Bucket.sort_order)).where(Bucket.user_id == user_id)
    if parent_id:
        query = query.where(Bucket.parent_id == parent_id)
    else:
        query = query.where(Bucket.parent_id.is_(None))
    return (db.scalar(query) or 0) + 1


def user_buckets(db: Session, user_id: str) -> list[Bucket]:
    return list(
        db.scalars(select(Bucket).where(Bucket.user_id == user_id).order_by(Bucket.sort_order, Bucket.created_at)).all()
    )


def ensure_org_bucket(db: Session, user_id: str, org: Organization) -> Bucket:
    name = (org.name or "Organization").strip()[:80] or "Organization"
    bucket = db.scalar(
        select(Bucket).where(Bucket.user_id == user_id, Bucket.organization_id == org.id)
    )
    if bucket is not None:
        bucket.name = name
        bucket.parent_id = None
        bucket.is_inbox = False
        return bucket
    bucket = Bucket(
        user_id=user_id,
        name=name,
        color="#e8a54b",
        sort_order=next_sibling_sort(db, user_id, None),
        is_inbox=False,
        parent_id=None,
        organization_id=org.id,
    )
    db.add(bucket)
    db.flush()
    return bucket


def ensure_project_bucket(
    db: Session,
    user_id: str,
    org_bucket: Bucket,
    project: PlanProject,
    color: str,
) -> Bucket:
    name = (project.name or "Project").strip()[:80] or "Project"
    bucket = db.scalar(
        select(Bucket).where(Bucket.user_id == user_id, Bucket.plan_project_id == project.id)
    )
    if bucket is not None:
        bucket.name = name
        bucket.parent_id = org_bucket.id
        bucket.is_inbox = False
        return bucket
    named = db.scalar(
        select(Bucket).where(
            Bucket.user_id == user_id,
            Bucket.parent_id == org_bucket.id,
            Bucket.name == name,
            Bucket.is_inbox.is_(False),
            Bucket.plan_project_id.is_(None),
            Bucket.organization_id.is_(None),
        )
    )
    if named is not None:
        named.plan_project_id = project.id
        named.parent_id = org_bucket.id
        named.name = name
        return named
    bucket = Bucket(
        user_id=user_id,
        name=name,
        color=color or "#e8a54b",
        sort_order=next_sibling_sort(db, user_id, org_bucket.id),
        is_inbox=False,
        parent_id=org_bucket.id,
        plan_project_id=project.id,
    )
    db.add(bucket)
    db.flush()
    return bucket
