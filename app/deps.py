from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import ApiToken, User
from app.orgs import is_site_admin_email, user_is_licensed
from app.security import hash_token

bearer_scheme = HTTPBearer(auto_error=False)


def get_session_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    return db.get(User, user_id)


def require_user(user: User | None = Depends(get_session_user)) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    return user


def require_licensed(
    request: Request,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
) -> User:
    org_id = request.session.get("active_organization_id")
    if user_is_licensed(db, user, org_id):
        return user
    raise HTTPException(status_code=403, detail="unlicensed")


def require_site_admin(user: User = Depends(require_user)) -> User:
    if is_site_admin_email(user.email):
        return user
    raise HTTPException(status_code=403, detail="Site admin only")


def require_admin(user: User = Depends(require_user)) -> User:
    if is_site_admin_email(user.email) or user.is_admin:
        return user
    raise HTTPException(status_code=403, detail="Admin only")


def require_token_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Missing API token")
    token = creds.credentials.strip()
    token_row = db.scalar(
        select(ApiToken).where(
            ApiToken.token_hash == hash_token(token),
            ApiToken.revoked_at.is_(None),
        )
    )
    if token_row is None:
        raise HTTPException(status_code=401, detail="Invalid API token")
    user = db.get(User, token_row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid API token")
    if not user_is_licensed(db, user):
        raise HTTPException(status_code=403, detail="unlicensed")
    token_row.last_used_at = datetime.now(timezone.utc)
    db.commit()
    return user
