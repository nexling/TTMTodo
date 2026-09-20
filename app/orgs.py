from __future__ import annotations

import copy
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.models import (
    ApiToken,
    Bucket,
    Department,
    DepartmentMember,
    Item,
    LicenseAssignment,
    Membership,
    Organization,
    OrganizationInvitation,
    PushSubscription,
    User,
)
from app.userfiles import (
    calendar_export_path,
    google_config_path,
    ical_config_path,
    outlook_config_path,
    remarkable_config_path,
    remarkable_key_path,
)

ROLE_OWNER = "owner"
ROLE_ADMIN = "admin"
ROLE_PROJECT_MANAGER = "project_manager"
ROLE_USER = "user"
ORGANIZATION_ROLES = (ROLE_OWNER, ROLE_ADMIN, ROLE_PROJECT_MANAGER, ROLE_USER)
ROLE_SORT_ORDER = {ROLE_OWNER: 0, ROLE_ADMIN: 1, ROLE_PROJECT_MANAGER: 2, ROLE_USER: 3}

MEMBERSHIP_STATUS_ACTIVE = "active"
MEMBERSHIP_STATUS_SUSPENDED = "suspended"

INVITATION_STATUS_PENDING = "pending"
INVITATION_STATUS_ACCEPTED = "accepted"
INVITATION_STATUS_REVOKED = "revoked"

LICENSE_TYPE_ORGANIZATION = "organization"
LICENSE_TYPE_INDIVIDUAL = "individual"
LICENSE_TYPES = (LICENSE_TYPE_ORGANIZATION, LICENSE_TYPE_INDIVIDUAL)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    try:
        text = str(value).strip()
    except Exception:
        return None
    return text or None


def _normalize_email(value: Any) -> str | None:
    text = _normalize_text(value)
    return text.lower() if text else None


def _normalize_role(value: Any, fallback: str = ROLE_USER) -> str:
    normalized = (_normalize_text(value) or fallback).lower()
    if normalized in {"member", "department_lead"}:
        normalized = ROLE_USER
    if normalized not in ORGANIZATION_ROLES:
        return fallback
    return normalized


def membership_capabilities(role: str) -> dict[str, bool]:
    role = _normalize_role(role)
    manage = role in {ROLE_OWNER, ROLE_ADMIN}
    return {
        "is_owner": role == ROLE_OWNER,
        "can_manage_organization": manage,
        "can_manage_members": manage,
        "can_invite_members": manage,
        "can_manage_plan": manage,
        "can_manage_project_work": manage or role == ROLE_PROJECT_MANAGER,
    }


def invitable_roles(actor_role: str) -> list[str]:
    if _normalize_role(actor_role) in {ROLE_OWNER, ROLE_ADMIN}:
        return [ROLE_ADMIN, ROLE_PROJECT_MANAGER, ROLE_USER]
    return []


def serialize_user(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "name": user.name,
        "auth_provider_id": user.auth_provider_id,
        "is_admin": bool(user.is_admin),
    }


def serialize_organization(org: Organization) -> dict[str, Any]:
    return {
        "id": org.id,
        "name": org.name,
        "owner_user_id": org.owner_user_id,
        "created_at": org.created_at.isoformat() if org.created_at else None,
    }


def serialize_membership(
    row: Membership, *, include_user: bool = False, include_organization: bool = False
) -> dict[str, Any]:
    role = _normalize_role(row.role)
    payload = {
        "id": row.id,
        "user_id": row.user_id,
        "organization_id": row.organization_id,
        "role": role,
        "status": row.status,
        "capabilities": membership_capabilities(role),
    }
    if include_user and row.user is not None:
        payload["user"] = serialize_user(row.user)
    if include_organization and row.organization is not None:
        payload["organization"] = serialize_organization(row.organization)
    return payload


def serialize_invitation(row: OrganizationInvitation) -> dict[str, Any]:
    payload = {
        "id": row.id,
        "organization_id": row.organization_id,
        "email": row.email,
        "role": _normalize_role(row.role),
        "status": row.status,
        "invited_by_user_id": row.invited_by_user_id,
        "accepted_user_id": row.accepted_user_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "accepted_at": row.accepted_at.isoformat() if row.accepted_at else None,
    }
    if getattr(row, "organization", None) is not None:
        payload["organization"] = serialize_organization(row.organization)
    return payload


def serialize_license(
    row: LicenseAssignment | None, *, include_user: bool = False, include_organization: bool = False
) -> dict[str, Any] | None:
    if row is None:
        return None
    payload = {
        "id": row.id,
        "license_type": row.license_type,
        "organization_id": row.organization_id,
        "user_id": row.user_id,
        "assigned_email": row.assigned_email,
        "seat_count": int(row.seat_count or 0),
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "expires_on": _as_utc(row.expires_at).date().isoformat() if row.expires_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "is_active": is_license_active(row),
        "status": "active" if is_license_active(row) else "expired",
    }
    if include_user and row.user is not None:
        payload["user"] = serialize_user(row.user)
    if include_organization and row.organization is not None:
        payload["organization"] = serialize_organization(row.organization)
    return payload


def default_license_access(reason: str = "no_active_membership") -> dict[str, Any]:
    return {
        "is_licensed": False,
        "source": None,
        "reason": reason,
        "seat_consumed": False,
        "organization_license_status": "missing",
        "organization_license": None,
        "individual_license": None,
    }


def is_license_active(row: LicenseAssignment | None, now: datetime | None = None) -> bool:
    if row is None or row.expires_at is None:
        return False
    now = now or _utcnow()
    expires = _as_utc(row.expires_at)
    return expires is not None and expires >= now


def normalize_expiration_date(value: Any) -> datetime:
    normalized = _normalize_text(value)
    if normalized is None:
        raise ValueError("Expiration date is required")
    parsed = None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            parsed = datetime.strptime(normalized, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError as exc:
            raise ValueError("Expiration date must be a valid date") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if len(normalized) == 10 and "T" not in normalized:
        parsed = parsed + timedelta(days=1) - timedelta(microseconds=1)
    return parsed


def normalize_seat_count(value: Any, minimum: int = 1) -> int:
    normalized = _normalize_text(value)
    if normalized is None:
        raise ValueError("Seat count is required")
    try:
        seat_count = int(normalized)
    except (TypeError, ValueError) as exc:
        raise ValueError("Seat count must be a whole number") from exc
    if seat_count < minimum:
        raise ValueError("Seat count must be at least 1" if minimum <= 1 else "Seat count cannot be negative")
    return seat_count


def _personal_org_name(display_name: str | None, email: str | None) -> str:
    if display_name:
        return display_name
    if email and "@" in email:
        return email.split("@", 1)[0]
    return "Personal organization"


def _unique_username(db: Session, base: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "", (base or "").strip())[:60] or "user"
    candidate = cleaned
    n = 1
    while db.scalar(select(User.id).where(User.username == candidate)):
        n += 1
        candidate = f"{cleaned}-{n}"[:80]
    return candidate


def _membership_sort_key(row: Membership) -> tuple:
    role = _normalize_role(row.role)
    org_name = ""
    if row.organization is not None and row.organization.name:
        org_name = row.organization.name.lower()
    return (ROLE_SORT_ORDER.get(role, 99), org_name, row.created_at or _utcnow(), row.id)


def org_license_record(db: Session, organization_id: str) -> LicenseAssignment | None:
    return db.scalar(
        select(LicenseAssignment)
        .where(
            LicenseAssignment.license_type == LICENSE_TYPE_ORGANIZATION,
            LicenseAssignment.organization_id == organization_id,
        )
        .order_by(LicenseAssignment.created_at.asc())
    )


def active_individual_license(
    db: Session, *, user_id: str | None = None, email: str | None = None, now: datetime | None = None
) -> LicenseAssignment | None:
    now = now or _utcnow()
    normalized_email = _normalize_email(email)
    if user_id is not None:
        rows = list(
            db.scalars(
                select(LicenseAssignment)
                .options(joinedload(LicenseAssignment.user))
                .where(
                    LicenseAssignment.license_type == LICENSE_TYPE_INDIVIDUAL,
                    LicenseAssignment.user_id == user_id,
                )
            )
        )
        active = [row for row in rows if is_license_active(row, now=now)]
        if active:
            active.sort(key=lambda row: _as_utc(row.expires_at) or now, reverse=True)
            return active[0]
    if normalized_email is None:
        return None
    rows = list(
        db.scalars(
            select(LicenseAssignment).where(
                LicenseAssignment.license_type == LICENSE_TYPE_INDIVIDUAL,
                LicenseAssignment.assigned_email == normalized_email,
            )
        )
    )
    active = [row for row in rows if is_license_active(row, now=now)]
    if not active:
        return None
    active.sort(key=lambda row: _as_utc(row.expires_at) or now, reverse=True)
    return active[0]


def has_individual_license(
    db: Session, *, user_id: str | None = None, email: str | None = None, now: datetime | None = None
) -> bool:
    return active_individual_license(db, user_id=user_id, email=email, now=now) is not None


def organization_license_summary(
    db: Session, organization_id: str, *, exclude_invitation_id: str | None = None, now: datetime | None = None
) -> dict[str, Any]:
    now = now or _utcnow()
    local_license = org_license_record(db, organization_id)
    active = local_license if is_license_active(local_license, now=now) else None
    members = list(
        db.scalars(
            select(Membership)
            .options(joinedload(Membership.user))
            .where(Membership.organization_id == organization_id, Membership.status == MEMBERSHIP_STATUS_ACTIVE)
        )
    )
    billed = 0
    individual_members = 0
    for member in members:
        if has_individual_license(db, user_id=member.user_id, email=getattr(member.user, "email", None), now=now):
            individual_members += 1
        else:
            billed += 1
    pending = list(
        db.scalars(
            select(OrganizationInvitation).where(
                OrganizationInvitation.organization_id == organization_id,
                OrganizationInvitation.status == INVITATION_STATUS_PENDING,
            )
        )
    )
    reserved_pending = 0
    individual_pending = 0
    for invite in pending:
        if exclude_invitation_id and invite.id == exclude_invitation_id:
            continue
        if has_individual_license(db, email=invite.email, now=now):
            individual_pending += 1
        else:
            reserved_pending += 1
    seat_count = int(active.seat_count or 0) if active is not None else 0
    reserved_total = billed + reserved_pending
    status = "missing"
    if local_license is not None:
        status = "active" if active is not None else "expired"
    return {
        "organization_id": organization_id,
        "license": serialize_license(local_license, include_organization=True),
        "status": status,
        "has_active_license": active is not None,
        "seat_count": seat_count,
        "seats_used": billed,
        "members_with_individual_license": individual_members,
        "pending_invitation_seats": reserved_pending,
        "pending_invitations_with_individual_license": individual_pending,
        "reserved_seats_total": reserved_total,
        "available_seats": max(seat_count - reserved_total, 0),
        "is_over_capacity": billed > seat_count,
        "active_member_count": len(members),
        "pending_invitation_count": len(pending),
    }


def membership_license_index(db: Session, organization_id: str, now: datetime | None = None) -> dict[str, dict[str, Any]]:
    now = now or _utcnow()
    local_license = org_license_record(db, organization_id)
    active = local_license if is_license_active(local_license, now=now) else None
    org_payload = serialize_license(local_license, include_organization=True)
    org_status = "missing"
    if local_license is not None:
        org_status = "active" if active is not None else "expired"
    members = list(
        db.scalars(
            select(Membership)
            .options(joinedload(Membership.user))
            .where(Membership.organization_id == organization_id, Membership.status == MEMBERSHIP_STATUS_ACTIVE)
            .order_by(Membership.created_at.asc(), Membership.id.asc())
        )
    )
    available = int(active.seat_count or 0) if active is not None else 0
    index: dict[str, dict[str, Any]] = {}
    for member in members:
        individual = active_individual_license(
            db, user_id=member.user_id, email=getattr(member.user, "email", None), now=now
        )
        if individual is not None:
            index[member.id] = {
                "is_licensed": True,
                "source": "individual",
                "reason": None,
                "seat_consumed": False,
                "organization_license_status": org_status,
                "organization_license": copy.deepcopy(org_payload),
                "individual_license": serialize_license(individual),
            }
            continue
        if active is not None and available > 0:
            available -= 1
            index[member.id] = {
                "is_licensed": True,
                "source": "organization_seat",
                "reason": None,
                "seat_consumed": True,
                "organization_license_status": org_status,
                "organization_license": copy.deepcopy(org_payload),
                "individual_license": None,
            }
            continue
        reason = "organization_seat_limit_reached"
        if org_status == "missing":
            reason = "organization_license_missing"
        elif org_status == "expired":
            reason = "organization_license_expired"
        index[member.id] = {
            "is_licensed": False,
            "source": None,
            "reason": reason,
            "seat_consumed": False,
            "organization_license_status": org_status,
            "organization_license": copy.deepcopy(org_payload),
            "individual_license": None,
        }
    return index


def require_seat_capacity(
    db: Session,
    organization_id: str,
    *,
    user_id: str | None = None,
    email: str | None = None,
    exclude_invitation_id: str | None = None,
) -> dict[str, Any]:
    if has_individual_license(db, user_id=user_id, email=email):
        return organization_license_summary(db, organization_id, exclude_invitation_id=exclude_invitation_id)
    summary = organization_license_summary(db, organization_id, exclude_invitation_id=exclude_invitation_id)
    if summary["available_seats"] > 0:
        return summary
    if summary["status"] == "missing":
        raise ValueError("Organization does not have an active organization license")
    if summary["status"] == "expired":
        raise ValueError("Organization license has expired")
    raise ValueError("Organization has no available licensed seats")


def link_individual_licenses(db: Session, user: User) -> None:
    email = _normalize_email(user.email)
    if email is None:
        return
    for row in db.scalars(
        select(LicenseAssignment).where(
            LicenseAssignment.license_type == LICENSE_TYPE_INDIVIDUAL,
            LicenseAssignment.assigned_email == email,
        )
    ):
        if row.user_id != user.id:
            row.user_id = user.id


def active_membership(db: Session, user_id: str, organization_id: str) -> Membership | None:
    return db.scalar(
        select(Membership).where(
            Membership.user_id == user_id,
            Membership.organization_id == organization_id,
            Membership.status == MEMBERSHIP_STATUS_ACTIVE,
        )
    )


def require_capability(db: Session, user_id: str, organization_id: str, capability: str) -> Membership:
    row = active_membership(db, user_id, organization_id)
    if row is None:
        raise PermissionError("You do not belong to this organization")
    caps = membership_capabilities(row.role)
    if not caps.get(capability):
        raise PermissionError("You do not have permission to perform this action")
    return row


def consume_pending_invitations(db: Session, user: User) -> int:
    email = _normalize_email(user.email)
    if email is None:
        return 0
    pending = list(
        db.scalars(
            select(OrganizationInvitation)
            .where(
                OrganizationInvitation.email == email,
                OrganizationInvitation.status == INVITATION_STATUS_PENDING,
            )
            .order_by(OrganizationInvitation.created_at.asc())
        )
    )
    consumed = 0
    for invite in pending:
        existing = db.scalar(
            select(Membership).where(
                Membership.user_id == user.id, Membership.organization_id == invite.organization_id
            )
        )
        role = _normalize_role(invite.role)
        if role != ROLE_OWNER and (existing is None or existing.status != MEMBERSHIP_STATUS_ACTIVE):
            require_seat_capacity(
                db,
                invite.organization_id,
                user_id=user.id,
                email=user.email,
                exclude_invitation_id=invite.id,
            )
        if existing is None:
            db.add(
                Membership(
                    user_id=user.id,
                    organization_id=invite.organization_id,
                    role=role,
                    status=MEMBERSHIP_STATUS_ACTIVE,
                )
            )
        else:
            existing.status = MEMBERSHIP_STATUS_ACTIVE
            existing.role = role
        if role == ROLE_OWNER:
            org = db.get(Organization, invite.organization_id)
            if org is not None and not org.owner_user_id:
                org.owner_user_id = user.id
        invite.status = INVITATION_STATUS_ACCEPTED
        invite.accepted_user_id = user.id
        invite.accepted_at = _utcnow()
        consumed += 1
    if consumed:
        db.flush()
    return consumed


def ensure_personal_organization(db: Session, user: User) -> Membership:
    existing = db.scalar(
        select(Membership)
        .join(Organization)
        .where(
            Membership.user_id == user.id,
            Membership.role == ROLE_OWNER,
            Membership.status == MEMBERSHIP_STATUS_ACTIVE,
            Organization.owner_user_id == user.id,
        )
        .order_by(Membership.created_at.asc())
    )
    if existing is not None:
        return existing
    org = Organization(name=_personal_org_name(user.name, user.email), owner_user_id=user.id)
    db.add(org)
    db.flush()
    row = Membership(
        user_id=user.id,
        organization_id=org.id,
        role=ROLE_OWNER,
        status=MEMBERSHIP_STATUS_ACTIVE,
    )
    db.add(row)
    db.flush()
    return row


def user_has_real_data(db: Session, user: User) -> bool:
    items = db.scalar(select(func.count()).select_from(Item).where(Item.user_id == user.id)) or 0
    if items:
        return True
    tokens = db.scalar(select(func.count()).select_from(ApiToken).where(ApiToken.user_id == user.id)) or 0
    if tokens:
        return True
    pushes = db.scalar(select(func.count()).select_from(PushSubscription).where(PushSubscription.user_id == user.id)) or 0
    if pushes:
        return True
    for path in (
        google_config_path(user.id),
        remarkable_config_path(user.id),
        remarkable_key_path(user.id),
        outlook_config_path(user.id),
        ical_config_path(user.id),
        calendar_export_path(user.id),
    ):
        if path.is_file() and path.stat().st_size > 2:
            return True
    return False


def delete_empty_user(db: Session, user: User) -> None:
    owned = list(
        db.scalars(
            select(Organization)
            .options(
                joinedload(Organization.memberships),
                joinedload(Organization.invitations),
                joinedload(Organization.licenses),
            )
            .where(Organization.owner_user_id == user.id)
        ).unique()
    )
    for org in owned:
        for row in list(org.memberships):
            db.delete(row)
        for row in list(org.invitations):
            db.delete(row)
        for row in list(org.licenses):
            db.delete(row)
        db.delete(org)
    db.flush()
    for model in (Membership, ApiToken, PushSubscription, Item, Bucket):
        for row in list(db.scalars(select(model).where(model.user_id == user.id))):
            db.delete(row)
    db.flush()
    try:
        calendar_export_path(user.id).unlink()
    except FileNotFoundError:
        pass
    db.delete(user)
    db.flush()


def get_user_context(db: Session, user_id: str, preferred_organization_id: str | None = None) -> dict[str, Any] | None:
    user = db.get(User, user_id)
    if user is None:
        return None
    memberships = list(
        db.scalars(
            select(Membership)
            .options(joinedload(Membership.organization), joinedload(Membership.user))
            .where(Membership.user_id == user.id, Membership.status == MEMBERSHIP_STATUS_ACTIVE)
        ).unique()
    )
    memberships.sort(key=_membership_sort_key)
    indexes: dict[str, dict[str, dict[str, Any]]] = {}
    payloads: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    for row in memberships:
        if row.organization_id not in indexes:
            indexes[row.organization_id] = membership_license_index(db, row.organization_id)
        payload = serialize_membership(row, include_organization=True)
        payload["license_access"] = copy.deepcopy(
            indexes[row.organization_id].get(row.id, default_license_access("organization_license_missing"))
        )
        payloads.append(payload)
        by_id[row.id] = payload
    current = None
    if preferred_organization_id:
        current = next((row for row in memberships if row.organization_id == preferred_organization_id), None)
    if current is None and memberships:
        current = memberships[0]
    if current is None or not (by_id.get(current.id) or {}).get("license_access", {}).get("is_licensed"):
        for row in memberships:
            if (by_id.get(row.id) or {}).get("license_access", {}).get("is_licensed"):
                current = row
                break
    current_payload = by_id.get(current.id) if current is not None else None
    license_access = default_license_access()
    if current_payload is not None:
        license_access = copy.deepcopy(current_payload.get("license_access") or license_access)
    else:
        individual = active_individual_license(db, user_id=user.id, email=user.email)
        if individual is not None:
            license_access = {
                "is_licensed": True,
                "source": "individual",
                "reason": None,
                "seat_consumed": False,
                "organization_license_status": "missing",
                "organization_license": None,
                "individual_license": serialize_license(individual),
            }
    org = current.organization if current is not None else None
    caps = (current_payload or {}).get("capabilities") or membership_capabilities(ROLE_USER)
    lead_ids: list[str] = []
    if org is not None:
        lead_ids = sorted(
            db.scalars(
                select(DepartmentMember.department_id)
                .join(Department, Department.id == DepartmentMember.department_id)
                .where(
                    Department.organization_id == org.id,
                    DepartmentMember.user_id == user.id,
                    DepartmentMember.is_lead.is_(True),
                )
            ).all()
        )
    caps = {**caps, "can_view_department_work": bool(caps.get("can_manage_project_work") or lead_ids)}
    return {
        "user": serialize_user(user),
        "organization": serialize_organization(org) if org is not None else None,
        "membership": current_payload,
        "organizations": payloads,
        "capabilities": caps,
        "license_access": license_access,
        "lead_department_ids": lead_ids,
    }


def user_is_licensed(db: Session, user: User, preferred_organization_id: str | None = None) -> bool:
    if not settings.auth0_is_enabled:
        return True
    ctx = get_user_context(db, user.id, preferred_organization_id)
    if ctx is None:
        return False
    return bool((ctx.get("license_access") or {}).get("is_licensed"))


def upsert_authenticated_user(
    db: Session,
    *,
    auth_provider_id: str,
    email: str | None,
    name: str | None,
) -> dict[str, Any]:
    auth_provider_id = _normalize_text(auth_provider_id) or ""
    email = _normalize_email(email)
    name = _normalize_text(name)
    if not auth_provider_id:
        raise ValueError("auth_provider_id is required")

    user = db.scalar(select(User).where(User.auth_provider_id == auth_provider_id))
    if user is None:
        username = _unique_username(db, (email or "user").split("@", 1)[0])
        user = User(
            username=username,
            password_hash="",
            email=email,
            name=name,
            auth_provider_id=auth_provider_id,
        )
        db.add(user)
        db.flush()
        from app.bootstrap import ensure_inbox

        ensure_inbox(db, user)
    else:
        if email and user.email != email:
            user.email = email
        if name and user.name != name:
            user.name = name

    link_individual_licenses(db, user)
    membership = ensure_personal_organization(db, user)
    consume_pending_invitations(db, user)
    db.flush()
    return get_user_context(db, user.id, membership.organization_id) or {}


def organization_settings(db: Session, user_id: str, organization_id: str | None) -> dict[str, Any] | None:
    ctx = get_user_context(db, user_id, organization_id)
    if ctx is None or ctx.get("organization") is None:
        return None
    org_id = ctx["organization"]["id"]
    members = list(
        db.scalars(
            select(Membership)
            .options(joinedload(Membership.user))
            .where(Membership.organization_id == org_id, Membership.status == MEMBERSHIP_STATUS_ACTIVE)
        ).unique()
    )
    members.sort(key=_membership_sort_key)
    pending = list(
        db.scalars(
            select(OrganizationInvitation)
            .where(
                OrganizationInvitation.organization_id == org_id,
                OrganizationInvitation.status == INVITATION_STATUS_PENDING,
            )
            .order_by(OrganizationInvitation.created_at.asc())
        )
    )
    actor_role = (ctx.get("membership") or {}).get("role") or ROLE_USER
    return {
        **ctx,
        "members": [serialize_membership(row, include_user=True) for row in members],
        "pending_invitations": [serialize_invitation(row) for row in pending],
        "invitable_roles": invitable_roles(actor_role),
        "license_summary": organization_license_summary(db, org_id),
    }


def pending_owner_email(db: Session, organization_id: str) -> str | None:
    invite = db.scalar(
        select(OrganizationInvitation)
        .where(
            OrganizationInvitation.organization_id == organization_id,
            OrganizationInvitation.role == ROLE_OWNER,
            OrganizationInvitation.status == INVITATION_STATUS_PENDING,
        )
        .order_by(OrganizationInvitation.created_at.asc())
    )
    return invite.email if invite is not None else None


def serialize_admin_organization(db: Session, org: Organization) -> dict[str, Any]:
    return {
        "organization": serialize_organization(org),
        "owner": serialize_user(org.owner) if org.owner is not None else None,
        "pending_owner_email": pending_owner_email(db, org.id),
        "license_summary": organization_license_summary(db, org.id),
    }


def create_organization(
    db: Session, name: str, owner_email: str, invited_by_user_id: str | None = None
) -> dict[str, Any]:
    name = _normalize_text(name)
    if not name:
        raise ValueError("Organization name is required")
    if len(name) > 120:
        raise ValueError("Organization name is too long")
    email = _normalize_email(owner_email)
    if email is None:
        raise ValueError("Owner email is required")
    org = Organization(name=name)
    db.add(org)
    db.flush()
    existing_user = db.scalar(select(User).where(func.lower(User.email) == email))
    if existing_user is not None:
        org.owner_user_id = existing_user.id
        db.add(
            Membership(
                user_id=existing_user.id,
                organization_id=org.id,
                role=ROLE_OWNER,
                status=MEMBERSHIP_STATUS_ACTIVE,
            )
        )
    else:
        db.add(
            OrganizationInvitation(
                organization_id=org.id,
                email=email,
                invited_by_user_id=invited_by_user_id,
                role=ROLE_OWNER,
                status=INVITATION_STATUS_PENDING,
            )
        )
    db.flush()
    db.refresh(org, attribute_names=["owner"])
    return serialize_admin_organization(db, org)


def rename_organization(db: Session, user_id: str, organization_id: str, name: str) -> dict[str, Any]:
    name = _normalize_text(name)
    if not name:
        raise ValueError("Organization name is required")
    require_capability(db, user_id, organization_id, "can_manage_organization")
    org = db.get(Organization, organization_id)
    if org is None:
        raise ValueError("Organization was not found")
    org.name = name
    db.flush()
    from app.plan import rename_organization_buckets

    rename_organization_buckets(db, organization_id, name)
    return serialize_organization(org)


def invite_user(db: Session, user_id: str, organization_id: str, email: str, role: str = ROLE_USER) -> dict[str, Any]:
    email = _normalize_email(email)
    if email is None:
        raise ValueError("Email is required")
    role = _normalize_role(role)
    if role == ROLE_OWNER:
        raise ValueError("Invitations cannot assign the owner role")
    actor = require_capability(db, user_id, organization_id, "can_invite_members")
    if role not in invitable_roles(actor.role):
        raise PermissionError("You are not allowed to invite users with that role")
    existing_user = db.scalar(select(User).where(func.lower(User.email) == email))
    if existing_user is not None:
        existing = db.scalar(
            select(Membership).where(
                Membership.user_id == existing_user.id, Membership.organization_id == organization_id
            )
        )
        if existing is None or existing.status != MEMBERSHIP_STATUS_ACTIVE:
            require_seat_capacity(db, organization_id, user_id=existing_user.id, email=existing_user.email)
        if existing is None:
            existing = Membership(
                user_id=existing_user.id,
                organization_id=organization_id,
                role=role,
                status=MEMBERSHIP_STATUS_ACTIVE,
            )
            db.add(existing)
        else:
            existing.role = role
            existing.status = MEMBERSHIP_STATUS_ACTIVE
        for invite in db.scalars(
            select(OrganizationInvitation).where(
                OrganizationInvitation.organization_id == organization_id,
                OrganizationInvitation.email == email,
                OrganizationInvitation.status == INVITATION_STATUS_PENDING,
            )
        ):
            invite.status = INVITATION_STATUS_ACCEPTED
            invite.accepted_user_id = existing_user.id
            invite.accepted_at = _utcnow()
        db.flush()
        return {"membership": serialize_membership(existing, include_user=True), "invitation": None}
    pending = db.scalar(
        select(OrganizationInvitation).where(
            OrganizationInvitation.organization_id == organization_id,
            OrganizationInvitation.email == email,
            OrganizationInvitation.status == INVITATION_STATUS_PENDING,
        )
    )
    if pending is None:
        require_seat_capacity(db, organization_id, email=email)
        pending = OrganizationInvitation(
            organization_id=organization_id,
            email=email,
            invited_by_user_id=user_id,
            role=role,
            status=INVITATION_STATUS_PENDING,
        )
        db.add(pending)
    else:
        require_seat_capacity(db, organization_id, email=email, exclude_invitation_id=pending.id)
        pending.role = role
        pending.invited_by_user_id = user_id
    db.flush()
    return {"membership": None, "invitation": serialize_invitation(pending)}


def update_membership_role(db: Session, user_id: str, organization_id: str, membership_id: str, role: str) -> dict[str, Any]:
    role = _normalize_role(role)
    if role == ROLE_OWNER:
        raise ValueError("Owner role cannot be assigned from settings")
    require_capability(db, user_id, organization_id, "can_manage_members")
    target = db.scalar(
        select(Membership)
        .options(joinedload(Membership.user))
        .where(
            Membership.id == membership_id,
            Membership.organization_id == organization_id,
            Membership.status == MEMBERSHIP_STATUS_ACTIVE,
        )
    )
    if target is None:
        raise ValueError("Member was not found")
    if _normalize_role(target.role) == ROLE_OWNER:
        raise ValueError("The organization owner cannot be changed here")
    target.role = role
    db.flush()
    return serialize_membership(target, include_user=True)


def suspend_membership(db: Session, user_id: str, organization_id: str, membership_id: str) -> None:
    require_capability(db, user_id, organization_id, "can_manage_members")
    target = db.scalar(
        select(Membership).where(
            Membership.id == membership_id,
            Membership.organization_id == organization_id,
            Membership.status == MEMBERSHIP_STATUS_ACTIVE,
        )
    )
    if target is None:
        raise ValueError("Member was not found")
    if _normalize_role(target.role) == ROLE_OWNER:
        raise ValueError("The organization owner cannot be removed")
    target.status = MEMBERSHIP_STATUS_SUSPENDED
    db.flush()


def revoke_invitation(db: Session, user_id: str, organization_id: str, invitation_id: str) -> None:
    require_capability(db, user_id, organization_id, "can_invite_members")
    invite = db.scalar(
        select(OrganizationInvitation).where(
            OrganizationInvitation.id == invitation_id,
            OrganizationInvitation.organization_id == organization_id,
            OrganizationInvitation.status == INVITATION_STATUS_PENDING,
        )
    )
    if invite is None:
        raise ValueError("Invitation was not found")
    for old in db.scalars(
        select(OrganizationInvitation).where(
            OrganizationInvitation.organization_id == organization_id,
            OrganizationInvitation.email == invite.email,
            OrganizationInvitation.status == INVITATION_STATUS_REVOKED,
            OrganizationInvitation.id != invite.id,
        )
    ):
        db.delete(old)
    db.flush()
    invite.status = INVITATION_STATUS_REVOKED
    db.flush()


def save_individual_license(
    db: Session, email: str, expires_at: Any, license_id: str | None = None
) -> tuple[dict[str, Any], bool]:
    email = _normalize_email(email)
    if email is None:
        raise ValueError("Email is required")
    expires = normalize_expiration_date(expires_at)
    local_user = db.scalar(select(User).where(func.lower(User.email) == email))
    row = None
    if license_id:
        row = db.scalar(
            select(LicenseAssignment).where(
                LicenseAssignment.id == license_id, LicenseAssignment.license_type == LICENSE_TYPE_INDIVIDUAL
            )
        )
        if row is None:
            raise ValueError("Individual license was not found")
    conflict = db.scalar(
        select(LicenseAssignment).where(
            LicenseAssignment.license_type == LICENSE_TYPE_INDIVIDUAL,
            or_(
                LicenseAssignment.assigned_email == email,
                LicenseAssignment.user_id == (local_user.id if local_user is not None else "__none__"),
            ),
        )
    )
    if conflict is not None and (row is None or conflict.id != row.id):
        row = conflict
    previous_email = row.assigned_email if row is not None else None
    created = row is None
    if row is None:
        row = LicenseAssignment(
            license_type=LICENSE_TYPE_INDIVIDUAL,
            assigned_email=email,
            user_id=local_user.id if local_user is not None else None,
            seat_count=0,
            expires_at=expires,
        )
        db.add(row)
    else:
        row.assigned_email = email
        row.user_id = local_user.id if local_user is not None else None
        row.seat_count = 0
        row.expires_at = expires
    db.flush()
    invite = created or (previous_email or "").lower() != email
    return serialize_license(row, include_user=True) or {}, invite


def save_organization_license(
    db: Session, organization_id: str, seat_count: Any, expires_at: Any, license_id: str | None = None
) -> dict[str, Any]:
    org = db.get(Organization, organization_id)
    if org is None:
        raise ValueError("Organization was not found")
    seats = normalize_seat_count(seat_count, minimum=1)
    expires = normalize_expiration_date(expires_at)
    row = None
    if license_id:
        row = db.scalar(
            select(LicenseAssignment).where(
                LicenseAssignment.id == license_id, LicenseAssignment.license_type == LICENSE_TYPE_ORGANIZATION
            )
        )
        if row is None:
            raise ValueError("Organization license was not found")
    existing = org_license_record(db, organization_id)
    if existing is not None and (row is None or existing.id != row.id):
        row = existing
    if row is None:
        row = LicenseAssignment(
            license_type=LICENSE_TYPE_ORGANIZATION,
            organization_id=organization_id,
            seat_count=seats,
            expires_at=expires,
        )
        db.add(row)
    else:
        row.organization_id = organization_id
        row.seat_count = seats
        row.expires_at = expires
    db.flush()
    return serialize_license(row, include_organization=True) or {}


def delete_license(db: Session, license_id: str) -> None:
    row = db.get(LicenseAssignment, license_id)
    if row is None:
        raise ValueError("License was not found")
    db.delete(row)
    db.flush()


def site_admin_context(db: Session) -> dict[str, Any]:
    users = list(db.scalars(select(User).order_by(func.lower(User.username).asc())))
    orgs = list(
        db.scalars(
            select(Organization).options(joinedload(Organization.owner)).order_by(func.lower(Organization.name).asc())
        )
    )
    individuals = list(
        db.scalars(
            select(LicenseAssignment)
            .options(joinedload(LicenseAssignment.user))
            .where(LicenseAssignment.license_type == LICENSE_TYPE_INDIVIDUAL)
            .order_by(LicenseAssignment.expires_at.asc())
        )
    )
    organization_rows = [serialize_admin_organization(db, org) for org in orgs]
    return {
        "known_users": [serialize_user(user) for user in users],
        "individual_licenses": [serialize_license(row, include_user=True) for row in individuals],
        "organizations": organization_rows,
    }


def is_site_admin_email(email: str | None) -> bool:
    normalized = _normalize_email(email)
    if not normalized:
        return False
    return normalized in settings.site_admin_email_set
