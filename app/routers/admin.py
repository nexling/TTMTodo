from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_site_admin
from app.mail import send_invite_email, send_test_mail
from app.models import User
from app.orgs import (
    create_organization,
    delete_license,
    save_individual_license,
    save_organization_license,
    site_admin_context,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])


class IndividualLicenseIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    expires_at: str
    license_id: str | None = None


class OrganizationLicenseIn(BaseModel):
    organization_id: str
    seat_count: int = Field(ge=1)
    expires_at: str
    license_id: str | None = None


class OrganizationCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    owner_email: str = Field(min_length=3, max_length=254)


class TestMailIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)


def _http(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@router.get("")
def admin_home(_admin: User = Depends(require_site_admin), db: Session = Depends(get_db)):
    return site_admin_context(db)


@router.post("/licenses/individual")
def put_individual(
    body: IndividualLicenseIn,
    _admin: User = Depends(require_site_admin),
    db: Session = Depends(get_db),
):
    try:
        payload, should_invite = save_individual_license(db, body.email, body.expires_at, body.license_id)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise _http(exc) from exc
    if should_invite:
        existing = bool(payload.get("user") or payload.get("user_id"))
        dest = payload.get("assigned_email") or body.email
        mail_ok, mail_err = send_invite_email(dest, existing_user=existing)
        payload["mail_sent"] = mail_ok
        payload["mail_error"] = None if mail_ok else (mail_err or "Could not send invitation email")
    return payload


@router.post("/organizations")
def add_organization(
    body: OrganizationCreateIn,
    admin: User = Depends(require_site_admin),
    db: Session = Depends(get_db),
):
    try:
        payload = create_organization(db, body.name, body.owner_email, invited_by_user_id=admin.id)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise _http(exc) from exc
    existing = payload.get("owner") is not None
    dest = payload.get("pending_owner_email") or ((payload.get("owner") or {}) or {}).get("email") or body.owner_email
    org_name = ((payload.get("organization") or {}) or {}).get("name") or body.name
    mail_ok, mail_err = send_invite_email(dest, org_name=org_name, existing_user=existing)
    payload["mail_sent"] = mail_ok
    payload["mail_error"] = None if mail_ok else (mail_err or "Could not send invitation email")
    return payload


@router.post("/licenses/organization")
def put_organization(
    body: OrganizationLicenseIn,
    _admin: User = Depends(require_site_admin),
    db: Session = Depends(get_db),
):
    try:
        payload = save_organization_license(
            db, body.organization_id, body.seat_count, body.expires_at, body.license_id
        )
        db.commit()
        return payload
    except ValueError as extra:
        db.rollback()
        raise _http(extra) from extra


@router.post("/licenses/{license_id}/delete")
def remove_license(
    license_id: str,
    _admin: User = Depends(require_site_admin),
    db: Session = Depends(get_db),
):
    try:
        delete_license(db, license_id)
        db.commit()
        return {"ok": True}
    except ValueError as exc:
        db.rollback()
        raise _http(exc) from exc


@router.post("/test-mail")
def test_mail(body: TestMailIn, _admin: User = Depends(require_site_admin)):
    ok, err, dest = send_test_mail(body.email)
    if not ok:
        raise HTTPException(status_code=400, detail=err or "Could not send test email")
    return {"ok": True, "to": dest}
