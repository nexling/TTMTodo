from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PlanProject, PlanTask, User, UserNotificationPreference

log = logging.getLogger("magictodo")

CATEGORY_TASK_ASSIGNED = "task_assigned"
CATEGORY_PLAN_DUE = "plan_due"
CATEGORY_ITEM_REMINDER = "item_reminder"

CATEGORIES: tuple[dict[str, object], ...] = (
    {
        "id": CATEGORY_TASK_ASSIGNED,
        "label": "Task assigned to you",
        "project_scoped": True,
    },
    {
        "id": CATEGORY_PLAN_DUE,
        "label": "Plan task due soon",
        "project_scoped": True,
    },
    {
        "id": CATEGORY_ITEM_REMINDER,
        "label": "Personal todo reminders",
        "project_scoped": False,
    },
)

CATEGORY_IDS = {str(row["id"]) for row in CATEGORIES}
PROJECT_SCOPED = {str(row["id"]) for row in CATEGORIES if row["project_scoped"]}


def _display_name(user: User) -> str:
    return (user.name or "").strip() or (user.email or "").strip() or user.username


def _pref_row(
    db: Session, user_id: str, category: str, project_id: str | None
) -> UserNotificationPreference | None:
    query = select(UserNotificationPreference).where(
        UserNotificationPreference.user_id == user_id,
        UserNotificationPreference.category == category,
    )
    if project_id is None:
        query = query.where(UserNotificationPreference.project_id.is_(None))
    else:
        query = query.where(UserNotificationPreference.project_id == project_id)
    return db.scalar(query)


def allowed(
    db: Session, user_id: str, category: str, project_id: str | None = None
) -> bool:
    if project_id:
        row = _pref_row(db, user_id, category, project_id)
        if row is not None:
            return bool(row.enabled)
    row = _pref_row(db, user_id, category, None)
    if row is not None:
        return bool(row.enabled)
    return True


def set_preference(
    db: Session,
    user_id: str,
    category: str,
    enabled: bool | None,
    project_id: str | None = None,
) -> None:
    if category not in CATEGORY_IDS:
        raise ValueError("Unknown notification category")
    if project_id and category not in PROJECT_SCOPED:
        raise ValueError("This category cannot be set per project")
    if project_id is None and enabled is None:
        raise ValueError("Global preference cannot inherit")
    row = _pref_row(db, user_id, category, project_id)
    if enabled is None:
        if row is not None:
            db.delete(row)
        return
    if row is None:
        db.add(
            UserNotificationPreference(
                user_id=user_id,
                category=category,
                project_id=project_id,
                enabled=enabled,
            )
        )
        return
    row.enabled = enabled


def serialize_preferences(db: Session, user: User, org_id: str | None) -> dict:
    global_prefs: dict[str, bool] = {}
    for row in CATEGORIES:
        category = str(row["id"])
        stored = _pref_row(db, user.id, category, None)
        global_prefs[category] = True if stored is None else bool(stored.enabled)

    projects: list[dict] = []
    if org_id:
        scoped = [str(row["id"]) for row in CATEGORIES if row["project_scoped"]]
        project_rows = list(
            db.scalars(
                select(PlanProject)
                .where(PlanProject.organization_id == org_id)
                .order_by(PlanProject.name, PlanProject.created_at.desc())
            ).all()
        )
        for project in project_rows:
            prefs: dict[str, bool | None] = {}
            for category in scoped:
                stored = _pref_row(db, user.id, category, project.id)
                prefs[category] = None if stored is None else bool(stored.enabled)
            projects.append({"id": project.id, "name": project.name, "prefs": prefs})

    return {
        "categories": [dict(row) for row in CATEGORIES],
        "global": global_prefs,
        "projects": projects,
    }


def notify_task_assigned(
    db: Session,
    *,
    task: PlanTask,
    actor: User,
    previous_assignee_id: str | None,
) -> None:
    assignee_id = task.assignee_user_id
    if not assignee_id or assignee_id == previous_assignee_id or assignee_id == actor.id:
        return
    if not allowed(db, assignee_id, CATEGORY_TASK_ASSIGNED, task.project_id):
        return
    assignee = db.get(User, assignee_id)
    if assignee is None:
        return
    project = task.project if task.project is not None else db.get(PlanProject, task.project_id)
    project_name = (project.name if project is not None else "").strip() or "project"
    title = (task.title or "").strip() or "Untitled"
    assigner = _display_name(actor)
    path = f"/org/projects/{task.project_id}"
    email = (assignee.email or "").strip()
    if email:
        from app.mail import send_assignment_email

        send_assignment_email(
            to=email,
            assigner=assigner,
            title=title,
            project_name=project_name,
            project_id=task.project_id,
        )
    from app.push import send_to_user

    send_to_user(
        db,
        assignee.id,
        {
            "title": title,
            "body": f"{assigner} assigned you this task in {project_name}",
            "url": path,
        },
    )
