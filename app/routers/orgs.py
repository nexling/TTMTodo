from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth0 import SESSION_ORG_KEY, store_session
from app.database import get_db
from app.deps import require_licensed, require_user
from app.mail import send_invite_email
from app.models import Organization, User
from app.orgs import (
    get_user_context,
    invite_user,
    organization_settings,
    rename_organization,
    revoke_invitation,
    suspend_membership,
    update_membership_role,
)

router = APIRouter(prefix="/api/orgs", tags=["orgs"])


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class InviteIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: str = "user"


class MembershipRoleIn(BaseModel):
    role: str = Field(min_length=1, max_length=32)


class SwitchIn(BaseModel):
    organization_id: str


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/settings")
def org_settings(
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    org_id = request.session.get(SESSION_ORG_KEY)
    payload = organization_settings(db, user.id, org_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="No organization")
    return payload


@router.post("/switch")
def switch_org(
    body: SwitchIn,
    request: Request,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    ctx = get_user_context(db, user.id, body.organization_id)
    if ctx is None or (ctx.get("organization") or {}).get("id") != body.organization_id:
        raise HTTPException(status_code=404, detail="Organization not found")
    store_session(request, ctx)
    return ctx


@router.post("/rename")
def rename(
    body: RenameIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    org_id = request.session.get(SESSION_ORG_KEY)
    if not org_id:
        raise HTTPException(status_code=400, detail="No active organization")
    try:
        payload = rename_organization(db, user.id, org_id, body.name)
        db.commit()
        return payload
    except (ValueError, PermissionError) as exc:
        db.rollback()
        raise _http(exc) from exc


@router.post("/invitations")
def create_invite(
    body: InviteIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    org_id = request.session.get(SESSION_ORG_KEY)
    if not org_id:
        raise HTTPException(status_code=400, detail="No active organization")
    try:
        payload = invite_user(db, user.id, org_id, body.email, body.role)
        db.commit()
    except (ValueError, PermissionError) as exc:
        db.rollback()
        raise _http(exc) from exc
    org = db.get(Organization, org_id)
    org_name = org.name if org is not None else None
    existing = payload.get("membership") is not None
    dest = body.email
    membership = payload.get("membership") or {}
    user_payload = membership.get("user") if isinstance(membership, dict) else None
    if isinstance(user_payload, dict) and user_payload.get("email"):
        dest = user_payload["email"]
    invitation = payload.get("invitation") or {}
    if isinstance(invitation, dict) and invitation.get("email"):
        dest = invitation["email"]
    mail_ok, mail_err = send_invite_email(dest, org_name=org_name, existing_user=existing)
    payload["mail_sent"] = mail_ok
    payload["mail_error"] = None if mail_ok else (mail_err or "Could not send invitation email")
    return payload


@router.post("/memberships/{membership_id}")
def patch_membership(
    membership_id: str,
    body: MembershipRoleIn,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    org_id = request.session.get(SESSION_ORG_KEY)
    if not org_id:
        raise HTTPException(status_code=400, detail="No active organization")
    try:
        payload = update_membership_role(db, user.id, org_id, membership_id, body.role)
        db.commit()
        return payload
    except (ValueError, PermissionError) as extra:
        db.rollback()
        raise _http(extra) from extra


@router.post("/memberships/{membership_id}/kick")
def kick_member(
    membership_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    org_id = request.session.get(SESSION_ORG_KEY)
    if not org_id:
        raise HTTPException(status_code=400, detail="No active organization")
    try:
        suspend_membership(db, user.id, org_id, membership_id)
        db.commit()
        return {"ok": True}
    except (ValueError, PermissionError) as exc:
        db.rollback()
        raise _http(exc) from exc


@router.post("/invitations/{invitation_id}/revoke")
def revoke_invite(
    invitation_id: str,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    org_id = request.session.get(SESSION_ORG_KEY)
    if not org_id:
        raise HTTPException(status_code=400, detail="No active organization")
    try:
        revoke_invitation(db, user.id, org_id, invitation_id)
        db.commit()
        return {"ok": True}
    except (ValueError, PermissionError) as exc:
        db.rollback()
        raise _http(exc) from exc
