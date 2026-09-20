from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth0 import SESSION_ORG_KEY
from app.bootstrap import ensure_inbox
from app.config import settings
from app.database import get_db
from app.deps import get_session_user
from app.models import User
from app.orgs import get_user_context, is_site_admin_email, user_is_licensed
from app.schemas import LoginIn, SetupIn, UserOut
from app.security import hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _status_payload(request: Request, user: User | None, db: Session) -> dict:
    org_id = request.session.get(SESSION_ORG_KEY)
    context = get_user_context(db, user.id, org_id) if user is not None else None
    licensed = False
    if user is not None:
        licensed = user_is_licensed(db, user, org_id)
    setup_required = False
    if not settings.auth0_is_enabled:
        setup_required = (db.scalar(select(func.count()).select_from(User)) or 0) == 0
    return {
        "setup_required": setup_required,
        "auth0_enabled": settings.auth0_is_enabled,
        "user": (context or {}).get("user") if context else (UserOut.model_validate(user).model_dump() if user else None),
        "is_site_admin": is_site_admin_email(user.email) if user else False,
        "licensed": licensed,
        "license_access": (context or {}).get("license_access"),
        "organization": (context or {}).get("organization"),
        "membership": (context or {}).get("membership"),
        "organizations": (context or {}).get("organizations") or [],
        "capabilities": (context or {}).get("capabilities"),
        "public_url": settings.public_url.rstrip("/"),
        "login_url": "/login",
        "logout_url": "/logout",
    }


@router.get("/status")
def auth_status(
    request: Request, user: User | None = Depends(get_session_user), db: Session = Depends(get_db)
):
    return _status_payload(request, user, db)


@router.post("/setup", response_model=UserOut)
def setup(body: SetupIn, request: Request, db: Session = Depends(get_db)):
    if settings.auth0_is_enabled:
        raise HTTPException(status_code=400, detail="Use Auth0 to create an account")
    existing = db.scalar(select(func.count()).select_from(User)) or 0
    if existing:
        raise HTTPException(status_code=400, detail="Already set up")
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username required")
    user = User(username=username, password_hash=hash_password(body.password), is_admin=True)
    db.add(user)
    db.flush()
    ensure_inbox(db, user)
    db.commit()
    db.refresh(user)
    request.session["user_id"] = user.id
    return UserOut.model_validate(user)


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    if settings.auth0_is_enabled:
        raise HTTPException(status_code=400, detail="Use Auth0 to sign in")
    user = db.scalar(select(User).where(User.username == body.username.strip()))
    if user is None or not user.password_hash or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Wrong username or password")
    request.session["user_id"] = user.id
    return UserOut.model_validate(user)


@router.post("/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True, "logout_url": "/logout"}
