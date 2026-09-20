from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    Bucket,
    Department,
    DepartmentMember,
    Item,
    Organization,
    PlanProject,
    PlanTask,
    PlanTaskDep,
    PlanTemplate,
    PlanTemplateDep,
    PlanTemplateTask,
    User,
)
from app.buckets import ensure_org_bucket, ensure_project_bucket
from app.orgs import get_user_context, serialize_user

log = logging.getLogger("magictodo")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_week_start(value: str | date) -> date:
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date) and not isinstance(value, datetime):
        return value - timedelta(days=value.weekday())
    text = str(value).strip().upper().replace("_", "-")
    if "W" in text:
        year_s, week_s = text.replace("W", "").split("-", 1)
        return date.fromisocalendar(int(year_s), int(week_s), 1)
    parsed = date.fromisoformat(str(value).strip()[:10])
    return parsed - timedelta(days=parsed.weekday())


def parse_due_on(value: str | date) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip().upper().replace("_", "-")
    if "W" in text:
        year_s, week_s = text.replace("W", "").split("-", 1)
        return date.fromisocalendar(int(year_s), int(week_s), 1)
    return date.fromisoformat(str(value).strip()[:10])


def resolve_due_on(*, due_on: str | None = None, week_start: str | None = None) -> date:
    value = due_on or week_start
    if not value:
        raise HTTPException(status_code=400, detail="due_on is required")
    return parse_due_on(value)


def iso_monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def week_label(day: date) -> str:
    iso = day.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def week_due_at(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, 9, 0, 0)


def _naive_dt(dt: datetime) -> datetime:
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def due_datetime(day: date, existing: datetime | None) -> datetime:
    if existing is None:
        return week_due_at(day)
    prev = _naive_dt(existing)
    old_date = prev.date()
    if old_date == day:
        return prev
    return prev + timedelta(days=(day - old_date).days)


def date_from_due_at(dt: datetime) -> date:
    return _naive_dt(dt).date()


def add_weeks(monday: date, offset: int) -> date:
    return monday + timedelta(weeks=offset)


SCHEDULE_DIRECTIONS = ("forward", "backward")


def normalize_schedule_direction(value: str | None, fallback: str = "forward") -> str:
    raw = value if value is not None and str(value).strip() else fallback
    text = str(raw or "forward").strip().lower()
    if text not in SCHEDULE_DIRECTIONS:
        raise HTTPException(status_code=400, detail="Schedule direction must be forward or backward")
    return text


def template_span_days(tasks: list[PlanTemplateTask]) -> int:
    return max((max(0, task.day_offset) for task in tasks), default=0)


def template_origin_date(
    db: Session,
    template: PlanTemplate,
    *,
    direction: str,
    start_week: str | date | None = None,
    delivery_on: str | date | None = None,
) -> date:
    direction = normalize_schedule_direction(direction)
    if direction == "backward":
        if not delivery_on:
            raise HTTPException(status_code=400, detail="Pick a delivery date for the template")
        tasks = list(db.scalars(select(PlanTemplateTask).where(PlanTemplateTask.template_id == template.id)).all())
        return parse_due_on(delivery_on) - timedelta(days=template_span_days(tasks))
    if not start_week:
        raise HTTPException(status_code=400, detail="Pick a start week for the template")
    return parse_week_start(start_week)


def require_active_org(db: Session, user: User, preferred_org_id: str | None) -> dict:
    ctx = get_user_context(db, user.id, preferred_org_id)
    if ctx is None or not ctx.get("organization"):
        raise HTTPException(status_code=404, detail="No organization")
    org = ctx["organization"]
    caps = ctx.get("capabilities") or {}
    return {"ctx": ctx, "org_id": org["id"], "org": org, "capabilities": caps}


def require_plan_admin(caps: dict) -> None:
    if not caps.get("can_manage_plan"):
        raise HTTPException(status_code=403, detail="Only organization admins can manage the plan")


def user_department_ids(db: Session, org_id: str, user_id: str) -> set[str]:
    rows = db.scalars(
        select(DepartmentMember.department_id)
        .join(Department, Department.id == DepartmentMember.department_id)
        .where(Department.organization_id == org_id, DepartmentMember.user_id == user_id)
    ).all()
    return set(rows)


def user_lead_department_ids(db: Session, org_id: str, user_id: str) -> set[str]:
    rows = db.scalars(
        select(DepartmentMember.department_id)
        .join(Department, Department.id == DepartmentMember.department_id)
        .where(
            Department.organization_id == org_id,
            DepartmentMember.user_id == user_id,
            DepartmentMember.is_lead.is_(True),
        )
    ).all()
    return set(rows)


def can_manage_dept_plan(
    db: Session, org_id: str, user_id: str, capabilities: dict, department_id: str | None
) -> bool:
    if capabilities.get("can_manage_project_work") or capabilities.get("can_manage_plan"):
        return True
    if not department_id:
        return False
    return department_id in user_lead_department_ids(db, org_id, user_id)


def require_dept_plan(
    db: Session,
    org_id: str,
    user_id: str,
    capabilities: dict,
    department_id: str | None,
    *,
    detail: str = "Only department leads can manage these tasks",
) -> None:
    if not can_manage_dept_plan(db, org_id, user_id, capabilities, department_id):
        raise HTTPException(status_code=403, detail=detail)


def set_user_departments(
    db: Session,
    org_id: str,
    user_id: str,
    department_ids: list[str],
    lead_ids: list[str] | None = None,
) -> None:
    from app.models import Membership
    from app.orgs import MEMBERSHIP_STATUS_ACTIVE

    membership = db.scalar(
        select(Membership).where(
            Membership.organization_id == org_id,
            Membership.user_id == user_id,
            Membership.status == MEMBERSHIP_STATUS_ACTIVE,
        )
    )
    if membership is None:
        raise HTTPException(status_code=400, detail="User is not in this organization")
    wanted: list[str] = []
    for department_id in department_ids:
        if department_id in wanted:
            continue
        load_department(db, org_id, department_id)
        wanted.append(department_id)
    lead_set = set(lead_ids or [])
    extra_leads = lead_set - set(wanted)
    if extra_leads:
        raise HTTPException(status_code=400, detail="A department lead must belong to that department")
    existing = list(
        db.scalars(
            select(DepartmentMember)
            .join(Department, Department.id == DepartmentMember.department_id)
            .where(Department.organization_id == org_id, DepartmentMember.user_id == user_id)
        ).all()
    )
    have = {row.department_id: row for row in existing}
    for department_id, row in list(have.items()):
        if department_id not in wanted:
            db.delete(row)
    for department_id in wanted:
        if department_id not in have:
            db.add(
                DepartmentMember(
                    department_id=department_id,
                    user_id=user_id,
                    is_lead=department_id in lead_set if lead_ids is not None else False,
                )
            )
        elif lead_ids is not None:
            have[department_id].is_lead = department_id in lead_set


def load_department(db: Session, org_id: str, department_id: str | None) -> Department | None:
    if not department_id:
        return None
    dept = db.get(Department, department_id)
    if dept is None or dept.organization_id != org_id:
        raise HTTPException(status_code=404, detail="Department not found")
    return dept


def load_project(db: Session, org_id: str, project_id: str) -> PlanProject:
    project = db.get(PlanProject, project_id)
    if project is None or project.organization_id != org_id:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def load_template(db: Session, org_id: str, template_id: str) -> PlanTemplate:
    template = db.get(PlanTemplate, template_id)
    if template is None or template.organization_id != org_id:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


def load_task(db: Session, org_id: str, task_id: str) -> PlanTask:
    task = db.get(PlanTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.get(PlanProject, task.project_id)
    if project is None or project.organization_id != org_id:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


def dep_edges_cycle(edges: list[tuple[str, str]]) -> bool:
    graph: dict[str, list[str]] = {}
    nodes: set[str] = set()
    for pred, succ in edges:
        if pred == succ:
            return True
        graph.setdefault(pred, []).append(succ)
        nodes.add(pred)
        nodes.add(succ)
    seen: set[str] = set()
    stack: set[str] = set()

    def dfs(node: str) -> bool:
        if node in stack:
            return True
        if node in seen:
            return False
        seen.add(node)
        stack.add(node)
        for nxt in graph.get(node, []):
            if dfs(nxt):
                return True
        stack.remove(node)
        return False

    return any(dfs(node) for node in nodes)


def task_predecessor_ids(db: Session, task_id: str) -> list[str]:
    return list(
        db.scalars(select(PlanTaskDep.predecessor_id).where(PlanTaskDep.successor_id == task_id)).all()
    )


def task_successor_ids(db: Session, task_id: str) -> list[str]:
    return list(
        db.scalars(select(PlanTaskDep.successor_id).where(PlanTaskDep.predecessor_id == task_id)).all()
    )


def _walk_undone_related(db: Session, start_ids: list[str], skip_id: str, outgoing: bool) -> list[PlanTask]:
    found: list[PlanTask] = []
    seen: set[str] = set()
    queue = list(start_ids)
    while queue:
        task_id = queue.pop(0)
        if not task_id or task_id in seen or task_id == skip_id:
            continue
        seen.add(task_id)
        row = db.get(PlanTask, task_id)
        if row is None or row.status == "done":
            continue
        found.append(row)
        nxt = task_successor_ids(db, task_id) if outgoing else task_predecessor_ids(db, task_id)
        queue.extend(nxt)
    return found


def related_undone(db: Session, task: PlanTask) -> dict[str, list[PlanTask]]:
    return {
        "upstream": _walk_undone_related(db, task_predecessor_ids(db, task.id), task.id, outgoing=False),
        "following": _walk_undone_related(db, task_successor_ids(db, task.id), task.id, outgoing=True),
    }


def serialize_related_task(task: PlanTask) -> dict:
    return {
        "id": task.id,
        "title": task.title,
        "due_on": task.week_start.isoformat(),
        "status": task.status,
    }


def task_predecessors_done(db: Session, task: PlanTask) -> bool:
    ids = task_predecessor_ids(db, task.id)
    if not ids:
        return True
    rows = list(db.scalars(select(PlanTask).where(PlanTask.id.in_(ids))).all())
    by_id = {row.id: row for row in rows}
    return all(by_id.get(pred_id) is not None and by_id[pred_id].status == "done" for pred_id in ids)


def leads_department(db: Session, org_id: str, user_id: str, department_id: str | None) -> bool:
    if not department_id:
        return False
    return department_id in user_lead_department_ids(db, org_id, user_id)


def can_complete_task(
    db: Session, user: User, org_id: str, task: PlanTask, capabilities: dict
) -> bool:
    if capabilities.get("can_manage_project_work") or capabilities.get("can_manage_plan"):
        return True
    if task.assignee_user_id == user.id:
        return True
    if leads_department(db, org_id, user.id, task.department_id):
        return True
    if task.assignee_user_id is None and task.department_id:
        return task.department_id in user_department_ids(db, org_id, user.id)
    return False


def set_task_status(db: Session, task: PlanTask, status: str) -> None:
    if status not in {"open", "done"}:
        raise HTTPException(status_code=400, detail="Status must be open or done")
    if status == "done" and not task_predecessors_done(db, task):
        raise HTTPException(status_code=400, detail="Waiting on other tasks")
    task.status = status
    task.completed_at = _utcnow() if status == "done" else None
    sync_plan_task_item(db, task)


def apply_item_status_to_plan(db: Session, item: Item, status: str) -> None:
    if not item.plan_task_id:
        return
    task = db.get(PlanTask, item.plan_task_id)
    if task is None:
        item.plan_task_id = None
        return
    if status == "done" and not task_predecessors_done(db, task):
        raise HTTPException(status_code=400, detail="Waiting on other tasks")
    task.status = status if status in {"open", "done"} else task.status
    task.completed_at = _utcnow() if task.status == "done" else None


def unlink_item(db: Session, task: PlanTask) -> None:
    if task.item_id:
        item = db.get(Item, task.item_id)
        if item is not None:
            item.plan_task_id = None
        task.item_id = None


def prune_empty_org_bucket(db: Session, bucket_id: str | None) -> None:
    if not bucket_id:
        return
    bucket = db.get(Bucket, bucket_id)
    if bucket is None or not bucket.organization_id:
        return
    remaining_items = db.scalar(select(func.count()).select_from(Item).where(Item.bucket_id == bucket.id)) or 0
    remaining_children = (
        db.scalar(select(func.count()).select_from(Bucket).where(Bucket.parent_id == bucket.id)) or 0
    )
    if remaining_items or remaining_children:
        return
    db.delete(bucket)
    db.flush()


def prune_empty_project_bucket(db: Session, bucket_id: str | None) -> None:
    if not bucket_id:
        return
    bucket = db.get(Bucket, bucket_id)
    if bucket is None or not bucket.plan_project_id:
        return
    remaining = db.scalar(select(func.count()).select_from(Item).where(Item.bucket_id == bucket.id)) or 0
    if remaining:
        return
    parent_id = bucket.parent_id
    db.delete(bucket)
    db.flush()
    prune_empty_org_bucket(db, parent_id)


def remove_plan_task_item(db: Session, task: PlanTask) -> None:
    item = db.get(Item, task.item_id) if task.item_id else None
    if item is None:
        item = db.scalar(select(Item).where(Item.plan_task_id == task.id))
    if item is None:
        task.item_id = None
        return
    from app.routers.items import delete_files

    bucket_id = item.bucket_id
    item.plan_task_id = None
    task.item_id = None
    delete_files(item)
    db.delete(item)
    db.flush()
    prune_empty_project_bucket(db, bucket_id)


def prune_stale_plan_inbox(db: Session) -> None:
    from app.routers.items import delete_files

    buckets = list(db.scalars(select(Bucket).where(Bucket.plan_project_id.is_not(None))).all())
    removed = 0
    for bucket in buckets:
        items = list(
            db.scalars(select(Item).where(Item.bucket_id == bucket.id, Item.source == "plan")).all()
        )
        for item in items:
            task = db.get(PlanTask, item.plan_task_id) if item.plan_task_id else None
            stale = item.plan_task_id is None or task is None or task.assignee_user_id != item.user_id
            if not stale:
                continue
            if task is not None and task.item_id == item.id:
                task.item_id = None
            item.plan_task_id = None
            delete_files(item)
            db.delete(item)
            removed += 1
        db.flush()
        prune_empty_project_bucket(db, bucket.id)
    for org_bucket in list(db.scalars(select(Bucket).where(Bucket.organization_id.is_not(None))).all()):
        prune_empty_org_bucket(db, org_bucket.id)
    if removed:
        log.info("Removed %s stale plan inbox items", removed)


def rename_project_buckets(db: Session, project: PlanProject, old_name: str, new_name: str) -> None:
    new = (new_name or "").strip()[:80] or "Project"
    for bucket in db.scalars(select(Bucket).where(Bucket.plan_project_id == project.id)).all():
        bucket.name = new


def unlock_project_buckets(db: Session, project_id: str) -> None:
    for bucket in db.scalars(select(Bucket).where(Bucket.plan_project_id == project_id)).all():
        bucket.plan_project_id = None


def rename_organization_buckets(db: Session, organization_id: str, name: str) -> None:
    new = (name or "").strip()[:80] or "Organization"
    for bucket in db.scalars(select(Bucket).where(Bucket.organization_id == organization_id)).all():
        bucket.name = new


def _assignee_project_bucket(db: Session, user_id: str, project: PlanProject, color: str) -> Bucket:
    org = db.get(Organization, project.organization_id)
    if org is None:
        raise HTTPException(status_code=400, detail="Organization was not found")
    org_bucket = ensure_org_bucket(db, user_id, org)
    return ensure_project_bucket(db, user_id, org_bucket, project, color)


def sync_plan_task_item(db: Session, task: PlanTask) -> None:
    project = db.get(PlanProject, task.project_id)
    if project is None:
        return
    if not task.assignee_user_id:
        remove_plan_task_item(db, task)
        return
    assignee = db.get(User, task.assignee_user_id)
    if assignee is None:
        remove_plan_task_item(db, task)
        return
    item = db.get(Item, task.item_id) if task.item_id else None
    if item is None:
        item = db.scalar(select(Item).where(Item.plan_task_id == task.id))
    if item is not None and item.user_id != task.assignee_user_id:
        remove_plan_task_item(db, task)
        item = None
    dept = db.get(Department, task.department_id) if task.department_id else None
    color = dept.color if dept is not None else "#e8a54b"
    bucket = _assignee_project_bucket(db, assignee.id, project, color)
    if item is None:
        from app.routers.items import next_sort_order

        item = Item(
            user_id=assignee.id,
            bucket_id=bucket.id,
            title=task.title[:500],
            notes=task.notes,
            source="plan",
            status=task.status,
            completed_at=task.completed_at,
            due_at=due_datetime(task.week_start, None),
            sort_order=next_sort_order(db, assignee, bucket.id, None, prepend=True),
        )
        db.add(item)
        db.flush()
        item.plan_task_id = task.id
        task.item_id = item.id
        return
    item.title = task.title[:500]
    item.notes = task.notes
    item.status = task.status
    item.completed_at = task.completed_at
    item.due_at = due_datetime(task.week_start, item.due_at)
    item.plan_task_id = task.id
    task.item_id = item.id
    if item.bucket_id != bucket.id:
        item.bucket_id = bucket.id


def next_cell_sort(db: Session, project_id: str, department_id: str | None, _week_start: date | None = None) -> int:
    val = db.scalar(
        select(func.max(PlanTask.sort_order)).where(
            PlanTask.project_id == project_id,
            PlanTask.department_id == department_id,
            PlanTask.parent_id.is_(None),
        )
    )
    return (val or 0) + 1


def next_child_sort(db: Session, parent_id: str) -> int:
    val = db.scalar(select(func.max(PlanTask.sort_order)).where(PlanTask.parent_id == parent_id))
    return (val or 0) + 1


def task_children(db: Session, parent_id: str) -> list[PlanTask]:
    return list(
        db.scalars(
            select(PlanTask)
            .where(PlanTask.parent_id == parent_id)
            .order_by(PlanTask.sort_order, PlanTask.created_at)
        ).all()
    )


def sync_child_schedule(db: Session, parent: PlanTask) -> None:
    if parent.parent_id:
        return
    for child in task_children(db, parent.id):
        child.department_id = parent.department_id
        child.week_start = parent.week_start
        sync_plan_task_item(db, child)


def place_task(
    db: Session,
    task: PlanTask,
    department_id: str | None,
    due_on: date,
    before_id: str | None = None,
) -> None:
    if task.parent_id:
        parent = db.get(PlanTask, task.parent_id)
        task.department_id = parent.department_id if parent is not None else department_id
        task.week_start = parent.week_start if parent is not None else due_on
        return
    siblings = list(
        db.scalars(
            select(PlanTask)
            .where(
                PlanTask.project_id == task.project_id,
                PlanTask.department_id == department_id,
                PlanTask.parent_id.is_(None),
                PlanTask.id != task.id,
            )
            .order_by(PlanTask.sort_order, PlanTask.created_at)
        ).all()
    )
    ids = [row.id for row in siblings]
    if before_id and before_id in ids:
        ids.insert(ids.index(before_id), task.id)
    else:
        ids.append(task.id)
    task.department_id = department_id
    task.week_start = due_on
    for index, sibling_id in enumerate(ids):
        row = task if sibling_id == task.id else db.get(PlanTask, sibling_id)
        if row is not None:
            row.sort_order = index
    sync_child_schedule(db, task)


def can_reschedule_task(
    db: Session, user: User, org_id: str, task: PlanTask, capabilities: dict
) -> bool:
    if capabilities.get("can_manage_project_work") or capabilities.get("can_manage_plan"):
        return True
    if task.assignee_user_id == user.id:
        return True
    return leads_department(db, org_id, user.id, task.department_id)


def apply_item_due_to_plan(db: Session, item: Item) -> None:
    if not item.plan_task_id:
        return
    task = db.get(PlanTask, item.plan_task_id)
    if task is None:
        item.plan_task_id = None
        return
    if item.due_at is None:
        return
    new_date = date_from_due_at(item.due_at)
    if task.week_start != new_date:
        task.week_start = new_date


def reschedule_task(
    db: Session,
    task: PlanTask,
    due_on: date,
    shift_upstream: bool,
    shift_following: bool,
    *,
    department_id: str | None = None,
    before_id: str | None = None,
    place: bool = False,
    due_at: datetime | None = None,
) -> None:
    delta = (due_on - task.week_start).days
    related = related_undone(db, task)
    if place:
        place_task(db, task, department_id, due_on, before_id)
    else:
        task.week_start = due_on
    sync_plan_task_item(db, task)
    if due_at is not None and task.item_id:
        item = db.get(Item, task.item_id)
        if item is not None:
            item.due_at = due_at if due_at.tzinfo is not None else due_at.replace(tzinfo=timezone.utc)
    if not delta:
        return
    targets: list[PlanTask] = []
    if shift_upstream:
        targets.extend(related["upstream"])
    if shift_following:
        targets.extend(related["following"])
    seen: set[str] = {task.id}
    for row in targets:
        if row.id in seen:
            continue
        seen.add(row.id)
        row.week_start = row.week_start + timedelta(days=delta)
        sync_plan_task_item(db, row)
        sync_child_schedule(db, row)
    if not place:
        sync_child_schedule(db, task)


def replace_task_deps(db: Session, task: PlanTask, predecessor_ids: list[str], org_id: str) -> None:
    unique: list[str] = []
    for pred_id in predecessor_ids:
        if pred_id == task.id or pred_id in unique:
            continue
        unique.append(pred_id)
    for pred_id in unique:
        load_task(db, org_id, pred_id)
    existing = list(db.scalars(select(PlanTaskDep).where(PlanTaskDep.successor_id == task.id)).all())
    keep = {(row.predecessor_id, row.successor_id) for row in existing}
    proposed = [(pred_id, task.id) for pred_id in unique]
    others = list(
        db.scalars(
            select(PlanTaskDep)
            .join(PlanTask, PlanTask.id == PlanTaskDep.successor_id)
            .where(PlanTask.project_id == task.project_id)
        ).all()
    )
    rest = [(row.predecessor_id, row.successor_id) for row in others if row.successor_id != task.id]
    if dep_edges_cycle(rest + proposed):
        raise HTTPException(status_code=400, detail="Dependencies cannot form a cycle")
    wanted = set(proposed)
    for row in existing:
        if (row.predecessor_id, row.successor_id) not in wanted:
            db.delete(row)
    for pred_id, succ_id in proposed:
        if (pred_id, succ_id) not in keep:
            db.add(PlanTaskDep(predecessor_id=pred_id, successor_id=succ_id))


def apply_template(db: Session, project: PlanProject, template: PlanTemplate, start_week: date) -> None:
    tasks = list(
        db.scalars(
            select(PlanTemplateTask)
            .where(PlanTemplateTask.template_id == template.id)
            .order_by(PlanTemplateTask.sort_order, PlanTemplateTask.title)
        ).all()
    )
    deps = list(
        db.scalars(
            select(PlanTemplateDep)
            .join(PlanTemplateTask, PlanTemplateTask.id == PlanTemplateDep.successor_id)
            .where(PlanTemplateTask.template_id == template.id)
        ).all()
    )
    id_map: dict[str, PlanTask] = {}
    for index, src in enumerate(tasks):
        created = PlanTask(
            project_id=project.id,
            title=src.title,
            notes=src.notes,
            department_id=src.department_id,
            week_start=start_week + timedelta(days=max(0, src.day_offset)),
            notify_days_before=src.notify_days_before,
            sort_order=src.sort_order if src.sort_order is not None else index,
            status="open",
        )
        db.add(created)
        db.flush()
        id_map[src.id] = created
    for dep in deps:
        pred = id_map.get(dep.predecessor_id)
        succ = id_map.get(dep.successor_id)
        if pred is None or succ is None:
            continue
        db.add(PlanTaskDep(predecessor_id=pred.id, successor_id=succ.id))


def serialize_department(dept: Department) -> dict:
    return {
        "id": dept.id,
        "organization_id": dept.organization_id,
        "name": dept.name,
        "color": dept.color,
        "sort_order": dept.sort_order,
        "member_ids": [row.user_id for row in dept.members],
        "lead_ids": [row.user_id for row in dept.members if row.is_lead],
    }


def serialize_template_task(task: PlanTemplateTask, predecessor_ids: list[str]) -> dict:
    return {
        "id": task.id,
        "title": task.title,
        "notes": task.notes,
        "department_id": task.department_id,
        "day_offset": task.day_offset,
        "week_offset": task.day_offset // 7,
        "notify_days_before": task.notify_days_before,
        "sort_order": task.sort_order,
        "predecessor_ids": predecessor_ids,
    }


def serialize_template(db: Session, template: PlanTemplate) -> dict:
    tasks = list(
        db.scalars(
            select(PlanTemplateTask)
            .where(PlanTemplateTask.template_id == template.id)
            .order_by(PlanTemplateTask.sort_order, PlanTemplateTask.title)
        ).all()
    )
    deps = list(
        db.scalars(
            select(PlanTemplateDep)
            .join(PlanTemplateTask, PlanTemplateTask.id == PlanTemplateDep.successor_id)
            .where(PlanTemplateTask.template_id == template.id)
        ).all()
    )
    preds: dict[str, list[str]] = {}
    for dep in deps:
        preds.setdefault(dep.successor_id, []).append(dep.predecessor_id)
    return {
        "id": template.id,
        "organization_id": template.organization_id,
        "name": template.name,
        "schedule_direction": normalize_schedule_direction(template.schedule_direction),
        "created_at": template.created_at,
        "task_count": len(tasks),
        "tasks": [serialize_template_task(task, preds.get(task.id, [])) for task in tasks],
    }


def serialize_project(project: PlanProject, task_count: int | None = None) -> dict:
    return {
        "id": project.id,
        "organization_id": project.organization_id,
        "name": project.name,
        "created_at": project.created_at,
        "task_count": task_count,
    }


def serialize_task(
    db: Session,
    task: PlanTask,
    *,
    user: User,
    org_id: str,
    capabilities: dict,
    assignee: User | None = None,
    project_name: str | None = None,
) -> dict:
    pred_ids = task_predecessor_ids(db, task.id)
    blocked = not task_predecessors_done(db, task)
    person = assignee if assignee is not None else (db.get(User, task.assignee_user_id) if task.assignee_user_id else None)
    from app.routers.items import attachment_out

    payload = {
        "id": task.id,
        "project_id": task.project_id,
        "title": task.title,
        "notes": task.notes,
        "department_id": task.department_id,
        "assignee_user_id": task.assignee_user_id,
        "assignee": serialize_user(person) if person is not None else None,
        "due_on": task.week_start.isoformat(),
        "week_start": iso_monday(task.week_start).isoformat(),
        "week_label": week_label(task.week_start),
        "notify_days_before": task.notify_days_before,
        "status": task.status,
        "sort_order": task.sort_order,
        "completed_at": task.completed_at,
        "predecessor_ids": pred_ids,
        "blocked": blocked,
        "can_complete": can_complete_task(db, user, org_id, task, capabilities) and not blocked,
        "can_manage": can_manage_dept_plan(db, org_id, user.id, capabilities, task.department_id),
        "item_id": task.item_id,
        "attachments": [attachment_out(att) for att in task.attachments],
        "parent_id": task.parent_id,
        "subtasks": [],
        "progress": None,
    }
    if not task.parent_id:
        children = task_children(db, task.id)
        payload["subtasks"] = [
            {
                "id": child.id,
                "title": child.title,
                "status": child.status,
                "assignee_user_id": child.assignee_user_id,
                "assignee": serialize_user(person) if (person := (db.get(User, child.assignee_user_id) if child.assignee_user_id else None)) is not None else None,
                "can_complete": can_complete_task(db, user, org_id, child, capabilities),
                "can_manage": can_manage_dept_plan(db, org_id, user.id, capabilities, child.department_id),
            }
            for child in children
        ]
        if children:
            done = sum(1 for child in children if child.status == "done")
            payload["progress"] = round(100 * done / len(children))
    if project_name is not None:
        payload["project_name"] = project_name
    return payload


def org_members(db: Session, org_id: str) -> list[dict]:
    from app.models import Membership
    from app.orgs import MEMBERSHIP_STATUS_ACTIVE, serialize_membership

    rows = list(
        db.scalars(
            select(Membership)
            .options(selectinload(Membership.user))
            .where(Membership.organization_id == org_id, Membership.status == MEMBERSHIP_STATUS_ACTIVE)
        ).all()
    )
    out = []
    for row in rows:
        payload = serialize_membership(row, include_user=True)
        out.append(payload)
    return out
