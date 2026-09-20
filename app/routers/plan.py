from datetime import datetime
import logging

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.auth0 import SESSION_ORG_KEY
from app.config import settings
from app.database import get_db
from app.deps import require_licensed
from app.models import (
    Attachment,
    Department,
    DepartmentMember,
    PlanProject,
    PlanTask,
    PlanTemplate,
    PlanTemplateDep,
    PlanTemplateTask,
    User,
)
from app.plan import (
    apply_template,
    can_reschedule_task,
    dep_edges_cycle,
    load_department,
    load_project,
    load_task,
    load_template,
    next_cell_sort,
    next_child_sort,
    normalize_schedule_direction,
    org_members,
    place_task,
    related_undone,
    rename_project_buckets,
    replace_task_deps,
    require_active_org,
    require_dept_plan,
    require_plan_admin,
    reschedule_task,
    resolve_due_on,
    template_origin_date,
    serialize_department,
    serialize_project,
    serialize_related_task,
    serialize_task,
    serialize_template,
    set_task_status,
    set_user_departments,
    remove_plan_task_item,
    task_children,
    unlink_item,
    sync_child_schedule,
    sync_plan_task_item,
    unlock_project_buckets,
    user_department_ids,
    user_lead_department_ids,
)
from app.routers.items import collect_uploads
from app.security import read_upload, store_upload, validate_color

log = logging.getLogger("magictodo")
router = APIRouter(prefix="/api/plan", tags=["plan"])


def _fire_plan_due_mail(
    db: Session,
    project_id: str | None = None,
    task_id: str | None = None,
    today=None,
) -> None:
    try:
        from app.mail import dispatch_plan_due_mail

        dispatch_plan_due_mail(db, project_id=project_id, task_id=task_id, today=today)
    except Exception:
        log.exception("Plan due email dispatch failed for project %s task %s", project_id, task_id)


def _fire_assignment_notify(
    db: Session, task: PlanTask, actor: User, previous_assignee_id: str | None
) -> None:
    try:
        from app.notifications import notify_task_assigned

        notify_task_assigned(db, task=task, actor=actor, previous_assignee_id=previous_assignee_id)
    except Exception:
        log.exception("Assignment notification failed for task %s", task.id)


class DepartmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#7c9a6d", max_length=16)


class DepartmentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = None
    sort_order: int | None = None
    member_ids: list[str] | None = None
    lead_ids: list[str] | None = None


class ReorderIds(BaseModel):
    ids: list[str] = Field(min_length=1)


class PersonDepartmentsIn(BaseModel):
    department_ids: list[str] = []
    lead_ids: list[str] | None = None


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class TemplateTaskIn(BaseModel):
    id: str | None = None
    title: str = Field(min_length=1, max_length=500)
    notes: str | None = None
    department_id: str | None = None
    day_offset: int | None = None
    week_offset: int = 0
    notify_days_before: int | None = Field(default=None, ge=0, le=365)
    sort_order: int = 0
    predecessor_ids: list[str] = []


class TemplateSaveIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    schedule_direction: str | None = None
    tasks: list[TemplateTaskIn]


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    template_id: str | None = None
    schedule_direction: str | None = None
    start_week: str | None = None
    delivery_on: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    notes: str | None = None
    department_id: str | None = None
    assignee_user_id: str | None = None
    due_on: str | None = None
    week_start: str | None = None
    notify_days_before: int | None = Field(default=None, ge=0, le=365)
    predecessor_ids: list[str] | None = None
    parent_id: str | None = None


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    notes: str | None = None
    department_id: str | None = None
    assignee_user_id: str | None = None
    due_on: str | None = None
    week_start: str | None = None
    notify_days_before: int | None = Field(default=None, ge=0, le=365)
    status: str | None = None
    predecessor_ids: list[str] | None = None
    sort_order: int | None = None


class TaskMoveIn(BaseModel):
    department_id: str | None = None
    due_on: str | None = None
    week_start: str | None = None
    before_id: str | None = None


class TaskRescheduleIn(BaseModel):
    due_on: str
    shift_upstream: bool = False
    shift_following: bool = False
    department_id: str | None = None
    before_id: str | None = None
    due_at: datetime | None = None


def _org(request: Request, user: User, db: Session) -> dict:
    return require_active_org(db, user, request.session.get(SESSION_ORG_KEY))


def _template_day_offset(src: TemplateTaskIn) -> int:
    if src.day_offset is not None:
        return max(0, src.day_offset)
    return max(0, src.week_offset) * 7


def _set_department_members(
    db: Session, org_id: str, dept: Department, member_ids: list[str], lead_ids: list[str] | None = None
) -> None:
    from app.models import Membership
    from app.orgs import MEMBERSHIP_STATUS_ACTIVE

    unique = []
    for user_id in member_ids:
        if user_id in unique:
            continue
        membership = db.scalar(
            select(Membership).where(
                Membership.organization_id == org_id,
                Membership.user_id == user_id,
                Membership.status == MEMBERSHIP_STATUS_ACTIVE,
            )
        )
        if membership is None:
            raise HTTPException(status_code=400, detail="User is not in this organization")
        unique.append(user_id)
    lead_set = set(lead_ids or [])
    extra_leads = lead_set - set(unique)
    if extra_leads:
        raise HTTPException(status_code=400, detail="A department lead must belong to that department")
    existing = {row.user_id: row for row in dept.members}
    for user_id, row in list(existing.items()):
        if user_id not in unique:
            db.delete(row)
    for user_id in unique:
        if user_id not in existing:
            db.add(
                DepartmentMember(
                    department_id=dept.id,
                    user_id=user_id,
                    is_lead=user_id in lead_set if lead_ids is not None else False,
                )
            )
        elif lead_ids is not None:
            existing[user_id].is_lead = user_id in lead_set


@router.get("/overview")
def overview(request: Request, user: User = Depends(require_licensed), db: Session = Depends(get_db)):
    ctx = _org(request, user, db)
    org_id = ctx["org_id"]
    departments = list(
        db.scalars(
            select(Department)
            .options(selectinload(Department.members))
            .where(Department.organization_id == org_id)
            .order_by(Department.sort_order, Department.name)
        ).all()
    )
    templates = list(
        db.scalars(
            select(PlanTemplate)
            .where(PlanTemplate.organization_id == org_id)
            .order_by(PlanTemplate.name)
        ).all()
    )
    projects = list(
        db.scalars(
            select(PlanProject)
            .where(PlanProject.organization_id == org_id)
            .order_by(PlanProject.created_at.desc())
        ).all()
    )
    counts = dict(
        db.execute(
            select(PlanTask.project_id, func.count())
            .join(PlanProject, PlanProject.id == PlanTask.project_id)
            .where(PlanProject.organization_id == org_id)
            .group_by(PlanTask.project_id)
        ).all()
    )
    orgs = []
    for row in ctx["ctx"].get("organizations") or []:
        org = row.get("organization") or {}
        orgs.append(
            {
                "id": org.get("id") or row.get("organization_id"),
                "name": org.get("name") or "Organization",
                "role": row.get("role"),
            }
        )
    return {
        "organization": ctx["org"],
        "capabilities": ctx["capabilities"],
        "organizations": orgs,
        "members": org_members(db, org_id),
        "departments": [serialize_department(dept) for dept in departments],
        "templates": [serialize_template(db, template) for template in templates],
        "projects": [serialize_project(project, counts.get(project.id, 0)) for project in projects],
        "my_department_ids": sorted(user_department_ids(db, org_id, user.id)),
        "lead_department_ids": sorted(user_lead_department_ids(db, org_id, user.id)),
    }


@router.post("/departments")
def create_department(
    body: DepartmentIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    color = validate_color(body.color)
    max_order = db.scalar(
        select(func.max(Department.sort_order)).where(Department.organization_id == ctx["org_id"])
    )
    dept = Department(
        organization_id=ctx["org_id"],
        name=body.name.strip(),
        color=color,
        sort_order=(max_order or 0) + 1,
    )
    db.add(dept)
    db.commit()
    db.refresh(dept)
    return serialize_department(dept)


@router.patch("/departments/{department_id}")
def update_department(
    department_id: str,
    body: DepartmentUpdate,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    dept = load_department(db, ctx["org_id"], department_id)
    assert dept is not None
    if body.name is not None:
        dept.name = body.name.strip()
    if body.color is not None:
        dept.color = validate_color(body.color)
    if body.sort_order is not None:
        dept.sort_order = body.sort_order
    if body.member_ids is not None or body.lead_ids is not None:
        members = body.member_ids if body.member_ids is not None else [row.user_id for row in dept.members]
        _set_department_members(db, ctx["org_id"], dept, members, body.lead_ids)
    db.commit()
    db.refresh(dept)
    db.refresh(dept, attribute_names=["members"])
    return serialize_department(dept)


@router.put("/people/{user_id}/departments")
def update_person_departments(
    user_id: str,
    body: PersonDepartmentsIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    set_user_departments(db, ctx["org_id"], user_id, body.department_ids, body.lead_ids)
    db.commit()
    return {"ok": True, "department_ids": body.department_ids, "lead_ids": body.lead_ids or []}


@router.get("/department-work")
def department_work(
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    caps = ctx["capabilities"]
    org_id = ctx["org_id"]
    lead_ids = user_lead_department_ids(db, org_id, user.id)
    see_all = bool(caps.get("can_manage_project_work") or caps.get("can_manage_plan"))
    if not see_all and not lead_ids:
        raise HTTPException(status_code=403, detail="Department work is for department leads and organization admins")
    mine = user_department_ids(db, org_id, user.id)
    departments = list(
        db.scalars(
            select(Department)
            .options(selectinload(Department.members))
            .where(Department.organization_id == org_id)
            .order_by(Department.sort_order, Department.name)
        ).all()
    )
    if see_all:
        visible = departments
        allowed_ids = {dept.id for dept in departments}
    else:
        visible = [dept for dept in departments if dept.id in lead_ids]
        allowed_ids = set(lead_ids)
    projects = list(
        db.scalars(
            select(PlanProject)
            .where(PlanProject.organization_id == org_id)
            .order_by(PlanProject.name, PlanProject.created_at.desc())
        ).all()
    )
    project_names = {row.id: row.name for row in projects}
    tasks_query = (
        select(PlanTask)
        .join(PlanProject, PlanProject.id == PlanTask.project_id)
        .where(PlanProject.organization_id == org_id)
        .order_by(PlanTask.week_start, PlanTask.sort_order, PlanTask.title)
    )
    if not see_all:
        if not allowed_ids:
            tasks: list[PlanTask] = []
        else:
            tasks = list(db.scalars(tasks_query.where(PlanTask.department_id.in_(allowed_ids))).all())
    else:
        tasks = list(db.scalars(tasks_query).all())
    return {
        "capabilities": caps,
        "my_department_ids": sorted(mine),
        "lead_department_ids": sorted(lead_ids),
        "members": org_members(db, org_id),
        "departments": [serialize_department(dept) for dept in visible],
        "projects": [serialize_project(project) for project in projects],
        "tasks": [
            serialize_task(
                db,
                task,
                user=user,
                org_id=org_id,
                capabilities=caps,
                project_name=project_names.get(task.project_id),
            )
            for task in tasks
        ],
    }


@router.post("/departments/reorder")
def reorder_departments(
    body: ReorderIds,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    loaded = []
    for dept_id in body.ids:
        dept = load_department(db, ctx["org_id"], dept_id)
        assert dept is not None
        loaded.append(dept)
    for index, dept in enumerate(loaded):
        dept.sort_order = index
    db.commit()
    return {"ok": True}


@router.delete("/departments/{department_id}")
def delete_department(
    department_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    dept = load_department(db, ctx["org_id"], department_id)
    assert dept is not None
    db.delete(dept)
    db.commit()
    return {"ok": True}


@router.post("/templates")
def create_template(
    body: TemplateIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    template = PlanTemplate(organization_id=ctx["org_id"], name=body.name.strip())
    db.add(template)
    db.commit()
    db.refresh(template)
    return serialize_template(db, template)


@router.get("/templates/{template_id}")
def get_template(
    template_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    template = load_template(db, ctx["org_id"], template_id)
    return serialize_template(db, template)


@router.put("/templates/{template_id}")
def save_template(
    template_id: str,
    body: TemplateSaveIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    template = load_template(db, ctx["org_id"], template_id)
    if body.name is not None:
        template.name = body.name.strip()
    if body.schedule_direction is not None:
        template.schedule_direction = normalize_schedule_direction(body.schedule_direction)
    old_tasks = list(
        db.scalars(select(PlanTemplateTask).where(PlanTemplateTask.template_id == template.id)).all()
    )
    old_ids = {task.id for task in old_tasks}
    existing_deps = list(
        db.scalars(
            select(PlanTemplateDep)
            .join(PlanTemplateTask, PlanTemplateTask.id == PlanTemplateDep.successor_id)
            .where(PlanTemplateTask.template_id == template.id)
        ).all()
    )
    for dep in existing_deps:
        db.delete(dep)
    db.flush()
    keep = {task.id for task in body.tasks if task.id and task.id in old_ids}
    for task in old_tasks:
        if task.id not in keep:
            db.delete(task)
    db.flush()
    id_map: dict[str, str] = {}
    created: list[PlanTemplateTask] = []
    for index, src in enumerate(body.tasks):
        load_department(db, ctx["org_id"], src.department_id)
        title = src.title.strip()
        notes = (src.notes or "").strip() or None
        day_offset = _template_day_offset(src)
        week_offset = day_offset // 7
        sort_order = src.sort_order if src.sort_order is not None else index
        if src.id and src.id in old_ids:
            row = db.get(PlanTemplateTask, src.id)
            if row is None or row.template_id != template.id:
                raise HTTPException(status_code=404, detail="Template task not found")
            row.title = title
            row.notes = notes
            row.department_id = src.department_id
            row.day_offset = day_offset
            row.week_offset = week_offset
            row.notify_days_before = src.notify_days_before
            row.sort_order = sort_order
        else:
            row = PlanTemplateTask(
                template_id=template.id,
                title=title,
                notes=notes,
                department_id=src.department_id,
                day_offset=day_offset,
                week_offset=week_offset,
                notify_days_before=src.notify_days_before,
                sort_order=sort_order,
            )
            db.add(row)
            db.flush()
        created.append(row)
        if src.id:
            id_map[src.id] = row.id
        id_map[row.id] = row.id
    edges: list[tuple[str, str]] = []
    for src, row in zip(body.tasks, created, strict=True):
        for pred_ref in src.predecessor_ids:
            pred_id = id_map.get(pred_ref)
            if not pred_id:
                continue
            edges.append((pred_id, row.id))
    if dep_edges_cycle(edges):
        raise HTTPException(status_code=400, detail="Dependencies cannot form a cycle")
    seen: set[tuple[str, str]] = set()
    for pred_id, succ_id in edges:
        if pred_id == succ_id or (pred_id, succ_id) in seen:
            continue
        seen.add((pred_id, succ_id))
        db.add(PlanTemplateDep(predecessor_id=pred_id, successor_id=succ_id))
    db.commit()
    return serialize_template(db, template)


@router.delete("/templates/{template_id}")
def delete_template(
    template_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    template = load_template(db, ctx["org_id"], template_id)
    db.delete(template)
    db.commit()
    return {"ok": True}


@router.post("/projects")
def create_project(
    body: ProjectIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    project = PlanProject(
        organization_id=ctx["org_id"],
        name=body.name.strip(),
        created_by_user_id=user.id,
    )
    db.add(project)
    db.flush()
    origin = None
    if body.template_id:
        template = load_template(db, ctx["org_id"], body.template_id)
        direction = normalize_schedule_direction(
            body.schedule_direction, template.schedule_direction or "forward"
        )
        origin = template_origin_date(
            db,
            template,
            direction=direction,
            start_week=body.start_week,
            delivery_on=body.delivery_on,
        )
        apply_template(db, project, template, origin)
    db.commit()
    db.expire_all()
    from app.mail import mail_today

    today = mail_today()
    if origin is not None and origin > today:
        today = origin
    _fire_plan_due_mail(db, project_id=project.id, today=today)
    return serialize_project(project, len(project.tasks))


@router.patch("/projects/{project_id}")
def update_project(
    project_id: str,
    body: ProjectUpdate,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    project = load_project(db, ctx["org_id"], project_id)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name is required")
        if name != project.name:
            rename_project_buckets(db, project, project.name, name)
            project.name = name
    db.commit()
    return serialize_project(project)


@router.delete("/projects/{project_id}")
def delete_project(
    project_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    require_plan_admin(ctx["capabilities"])
    project = load_project(db, ctx["org_id"], project_id)
    tasks = list(db.scalars(select(PlanTask).where(PlanTask.project_id == project.id)).all())
    for task in tasks:
        unlink_item(db, task)
    unlock_project_buckets(db, project.id)
    db.delete(project)
    db.commit()
    return {"ok": True}


@router.get("/projects/{project_id}")
def get_project(
    project_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    project = load_project(db, ctx["org_id"], project_id)
    departments = list(
        db.scalars(
            select(Department)
            .options(selectinload(Department.members))
            .where(Department.organization_id == ctx["org_id"])
            .order_by(Department.sort_order, Department.name)
        ).all()
    )
    tasks = list(
        db.scalars(
            select(PlanTask)
            .where(PlanTask.project_id == project.id)
            .order_by(PlanTask.week_start, PlanTask.sort_order, PlanTask.created_at)
        ).all()
    )
    return {
        "project": serialize_project(project, len(tasks)),
        "capabilities": ctx["capabilities"],
        "members": org_members(db, ctx["org_id"]),
        "departments": [serialize_department(dept) for dept in departments],
        "lead_department_ids": sorted(user_lead_department_ids(db, ctx["org_id"], user.id)),
        "tasks": [
            serialize_task(db, task, user=user, org_id=ctx["org_id"], capabilities=ctx["capabilities"])
            for task in tasks
        ],
    }


@router.post("/projects/{project_id}/tasks")
def create_task(
    project_id: str,
    body: TaskIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    project = load_project(db, ctx["org_id"], project_id)
    parent = None
    department_id = body.department_id
    if body.parent_id:
        parent = load_task(db, ctx["org_id"], body.parent_id)
        if parent.project_id != project.id:
            raise HTTPException(status_code=400, detail="Parent task is not in this project")
        if parent.parent_id:
            raise HTTPException(status_code=400, detail="Subtasks cannot have subtasks")
        department_id = parent.department_id
        due_on = parent.week_start
        sort_order = next_child_sort(db, parent.id)
    else:
        due_on = resolve_due_on(due_on=body.due_on, week_start=body.week_start)
        sort_order = next_cell_sort(db, project.id, department_id, due_on)
    require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], department_id)
    load_department(db, ctx["org_id"], department_id)
    task = PlanTask(
        project_id=project.id,
        title=body.title.strip(),
        notes=(body.notes or "").strip() or None,
        department_id=department_id,
        assignee_user_id=body.assignee_user_id,
        week_start=due_on,
        notify_days_before=body.notify_days_before,
        sort_order=sort_order,
        status="open",
        parent_id=parent.id if parent is not None else None,
    )
    db.add(task)
    db.flush()
    if body.predecessor_ids and not task.parent_id:
        replace_task_deps(db, task, body.predecessor_ids, ctx["org_id"])
    sync_plan_task_item(db, task)
    db.commit()
    db.refresh(task)
    if task.notify_days_before is not None:
        _fire_plan_due_mail(db, project_id=project.id, task_id=task.id)
    _fire_assignment_notify(db, task, user, None)
    return serialize_task(db, task, user=user, org_id=ctx["org_id"], capabilities=ctx["capabilities"])


@router.patch("/tasks/{task_id}")
def update_task(
    task_id: str,
    body: TaskUpdate,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    task = load_task(db, ctx["org_id"], task_id)
    previous_assignee_id = task.assignee_user_id
    assignee_changed = False
    fields = body.model_fields_set
    if "status" in fields and body.status is not None:
        if body.status == "done" and not (
            ctx["capabilities"].get("can_manage_project_work") or ctx["capabilities"].get("can_manage_plan")
        ):
            from app.plan import can_complete_task

            if not can_complete_task(db, user, ctx["org_id"], task, ctx["capabilities"]):
                raise HTTPException(status_code=403, detail="You cannot complete this task")
        if body.status != task.status:
            set_task_status(db, task, body.status)
    else:
        require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], task.department_id)
        if "department_id" in fields:
            require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], body.department_id)
            load_department(db, ctx["org_id"], body.department_id)
            if not task.parent_id:
                task.department_id = body.department_id
        if body.title is not None:
            task.title = body.title.strip()
        if "notes" in fields:
            task.notes = (body.notes or "").strip() or None
        if "assignee_user_id" in fields:
            task.assignee_user_id = body.assignee_user_id
            assignee_changed = True
        if "notify_days_before" in fields:
            task.notify_days_before = body.notify_days_before
        if (body.due_on is not None or body.week_start is not None) and not task.parent_id:
            task.week_start = resolve_due_on(due_on=body.due_on, week_start=body.week_start)
        if body.sort_order is not None:
            task.sort_order = body.sort_order
        if body.predecessor_ids is not None and not task.parent_id:
            replace_task_deps(db, task, body.predecessor_ids, ctx["org_id"])
        sync_plan_task_item(db, task)
        if not task.parent_id:
            sync_child_schedule(db, task)
    db.commit()
    db.refresh(task)
    if task.status == "open" and task.notify_days_before is not None:
        _fire_plan_due_mail(db, project_id=task.project_id, task_id=task.id)
    if assignee_changed:
        _fire_assignment_notify(db, task, user, previous_assignee_id)
    return serialize_task(db, task, user=user, org_id=ctx["org_id"], capabilities=ctx["capabilities"])


@router.post("/tasks/{task_id}/move")
def move_task(
    task_id: str,
    body: TaskMoveIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    task = load_task(db, ctx["org_id"], task_id)
    require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], task.department_id)
    require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], body.department_id)
    load_department(db, ctx["org_id"], body.department_id)
    due_on = resolve_due_on(due_on=body.due_on, week_start=body.week_start)
    place_task(db, task, body.department_id, due_on, body.before_id)
    sync_plan_task_item(db, task)
    db.commit()
    db.refresh(task)
    if task.notify_days_before is not None:
        _fire_plan_due_mail(db, project_id=task.project_id, task_id=task.id)
    return serialize_task(db, task, user=user, org_id=ctx["org_id"], capabilities=ctx["capabilities"])


@router.get("/tasks/{task_id}/related")
def related_tasks(
    task_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    task = load_task(db, ctx["org_id"], task_id)
    related = related_undone(db, task)
    return {
        "upstream": [serialize_related_task(row) for row in related["upstream"]],
        "following": [serialize_related_task(row) for row in related["following"]],
    }


@router.post("/tasks/{task_id}/reschedule")
def reschedule(
    task_id: str,
    body: TaskRescheduleIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    task = load_task(db, ctx["org_id"], task_id)
    if not can_reschedule_task(db, user, ctx["org_id"], task, ctx["capabilities"]):
        raise HTTPException(status_code=403, detail="You cannot reschedule this task")
    fields = body.model_fields_set
    place = "department_id" in fields or "before_id" in fields
    department_id = body.department_id if "department_id" in fields else task.department_id
    if place:
        load_department(db, ctx["org_id"], department_id)
        if department_id != task.department_id or "before_id" in fields:
            require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], task.department_id)
            require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], department_id)
    due_on = resolve_due_on(due_on=body.due_on)
    reschedule_task(
        db,
        task,
        due_on,
        body.shift_upstream,
        body.shift_following,
        department_id=department_id,
        before_id=body.before_id,
        place=place,
        due_at=body.due_at,
    )
    db.commit()
    db.refresh(task)
    if task.notify_days_before is not None:
        _fire_plan_due_mail(db, project_id=task.project_id, task_id=task.id)
    return serialize_task(db, task, user=user, org_id=ctx["org_id"], capabilities=ctx["capabilities"])


@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    task = load_task(db, ctx["org_id"], task_id)
    require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], task.department_id)
    for child in task_children(db, task.id):
        remove_plan_task_item(db, child)
        db.delete(child)
    remove_plan_task_item(db, task)
    db.delete(task)
    db.commit()
    return {"ok": True}


@router.post("/tasks/{task_id}/attachments")
async def add_task_attachments(
    task_id: str,
    request: Request,
    image: UploadFile | None = File(default=None),
    file: UploadFile | None = File(default=None),
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    task = load_task(db, ctx["org_id"], task_id)
    require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], task.department_id)
    uploads = collect_uploads(file, image)
    if not uploads:
        raise HTTPException(status_code=400, detail="Choose a file")
    for upload in uploads:
        data, mime, ext, original = read_upload(upload)
        stored = store_upload(data, ext)
        db.add(
            Attachment(
                item_id=None,
                plan_task_id=task.id,
                original_name=original,
                stored_name=stored,
                mime_type=mime,
                size=len(data),
            )
        )
    db.commit()
    db.refresh(task)
    db.expire(task, ["attachments"])
    return serialize_task(db, task, user=user, org_id=ctx["org_id"], capabilities=ctx["capabilities"])


@router.delete("/tasks/{task_id}/attachments/{attachment_id}")
def delete_task_attachment(
    task_id: str,
    attachment_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    ctx = _org(request, user, db)
    task = load_task(db, ctx["org_id"], task_id)
    require_dept_plan(db, ctx["org_id"], user.id, ctx["capabilities"], task.department_id)
    att = next((row for row in task.attachments if row.id == attachment_id), None)
    if att is None:
        raise HTTPException(status_code=404, detail="File not found")
    path = settings.upload_dir / att.stored_name
    if path.is_file():
        path.unlink()
    db.delete(att)
    db.commit()
    db.refresh(task)
    db.expire(task, ["attachments"])
    return serialize_task(db, task, user=user, org_id=ctx["org_id"], capabilities=ctx["capabilities"])

