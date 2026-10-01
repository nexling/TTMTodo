from __future__ import annotations

import logging
import shutil
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.models import (
    ApiToken,
    Attachment,
    Bucket,
    DepartmentMember,
    GoogleImport,
    Item,
    LicenseAssignment,
    Membership,
    Organization,
    OrganizationInvitation,
    PlanProject,
    PlanTask,
    PushSubscription,
    RemarkableImport,
    User,
    UserNotificationPreference,
)

log = logging.getLogger("magictodo.offboard")


class OffboardError(Exception):
    pass


def find_user(db: Session, ident: str) -> User:
    raw = (ident or "").strip()
    if not raw:
        raise OffboardError("Pass a user id, email, or username")
    user = db.get(User, raw)
    if user is not None:
        return user
    lowered = raw.lower()
    user = db.scalar(select(User).where(func.lower(User.email) == lowered))
    if user is not None:
        return user
    user = db.scalar(select(User).where(func.lower(User.username) == lowered))
    if user is not None:
        return user
    raise OffboardError(f"No user matches {raw!r}")


def owned_organizations(db: Session, user: User) -> list[Organization]:
    return list(db.scalars(select(Organization).where(Organization.owner_user_id == user.id)))


def _unlink_attachment(att: Attachment) -> None:
    path = settings.upload_dir / att.stored_name
    if path.is_file():
        path.unlink()


def _delete_organization(db: Session, org: Organization) -> None:
    projects = list(db.scalars(select(PlanProject).where(PlanProject.organization_id == org.id)))
    project_ids = [row.id for row in projects]
    if project_ids:
        tasks = list(db.scalars(select(PlanTask).where(PlanTask.project_id.in_(project_ids))))
        task_ids = [row.id for row in tasks]
        if task_ids:
            for att in db.scalars(select(Attachment).where(Attachment.plan_task_id.in_(task_ids))):
                _unlink_attachment(att)
                db.delete(att)
            db.flush()
        for project in projects:
            db.delete(project)
        db.flush()
    db.delete(org)
    db.flush()


def wipe_user_files(user: User) -> None:
    path = settings.data_dir / "users" / user.id
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)


def wipe_user(db: Session, user: User, *, delete_owned_orgs: bool = False) -> dict[str, Any]:
    owned = owned_organizations(db, user)
    if owned and not delete_owned_orgs:
        names = ", ".join(org.name for org in owned)
        raise OffboardError(
            f"{user.email or user.username} owns organization(s): {names}. "
            "Pass --delete-owned-orgs to remove those orgs and their Plan data."
        )

    summary = {
        "user_id": user.id,
        "username": user.username,
        "email": user.email,
        "organizations_deleted": [org.name for org in owned] if delete_owned_orgs else [],
    }

    items = list(
        db.scalars(select(Item).options(selectinload(Item.attachments)).where(Item.user_id == user.id))
    )
    for item in items:
        for att in list(item.attachments):
            _unlink_attachment(att)

    if delete_owned_orgs:
        for org in owned:
            _delete_organization(db, org)

    for model in (
        DepartmentMember,
        Membership,
        ApiToken,
        PushSubscription,
        UserNotificationPreference,
        GoogleImport,
        RemarkableImport,
        LicenseAssignment,
    ):
        if model is LicenseAssignment:
            clauses = [LicenseAssignment.user_id == user.id]
            if user.email:
                clauses.append(func.lower(LicenseAssignment.assigned_email) == user.email.lower())
            rows = list(db.scalars(select(LicenseAssignment).where(or_(*clauses))))
        else:
            rows = list(db.scalars(select(model).where(model.user_id == user.id)))
        for row in rows:
            db.delete(row)
    db.flush()

    invite_clauses = [
        OrganizationInvitation.invited_by_user_id == user.id,
        OrganizationInvitation.accepted_user_id == user.id,
    ]
    if user.email:
        invite_clauses.append(func.lower(OrganizationInvitation.email) == user.email.lower())
    invites = list(db.scalars(select(OrganizationInvitation).where(or_(*invite_clauses))))
    for row in invites:
        db.delete(row)
    db.flush()

    for item in list(db.scalars(select(Item).where(Item.user_id == user.id))):
        db.delete(item)
    db.flush()
    for bucket in list(db.scalars(select(Bucket).where(Bucket.user_id == user.id))):
        db.delete(bucket)
    db.flush()

    wipe_user_files(user)

    db.delete(user)
    db.flush()
    log.info("Wiped user %s (%s)", summary["username"], summary["user_id"])
    return summary
