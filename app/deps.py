from datetime import datetime, timezone
import json

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import ApiToken, User
from app.orgs import is_site_admin_email, user_is_licensed
from app.schemas import API_SCOPES
from app.security import hash_token

bearer_scheme = HTTPBearer(auto_error=False)


def parse_token_scopes(raw: str | None) -> list[str]:
    try:
        parsed = json.loads(raw or "[]")
    except json.JSONDecodeError:
        parsed = []
    if not isinstance(parsed, list):
        return ["inbox"]
    out: list[str] = []
    for value in parsed:
        name = str(value).strip().lower()
        if name in API_SCOPES and name not in out:
            out.append(name)
    return out or ["inbox"]


def encode_token_scopes(scopes: list[str] | None) -> str:
    out: list[str] = []
    for value in scopes or []:
        name = (value or "").strip().lower()
        if name not in API_SCOPES:
            raise HTTPException(status_code=400, detail=f"Unknown scope: {value}")
        if name not in out:
            out.append(name)
    if not out:
        out = ["inbox"]
    return json.dumps(out)


def token_has_scope(token: ApiToken, scope: str) -> bool:
    return scope in parse_token_scopes(token.scopes)


def _load_bearer_token(
    creds: HTTPAuthorizationCredentials | None, db: Session
) -> tuple[User, ApiToken]:
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
    db.refresh(token_row)
    db.refresh(user)
    return user, token_row


def _bind_principal(request: Request, user: User, token: ApiToken | None) -> User:
    request.state.api_user = user
    request.state.api_token = token
    request.state.api_scopes = parse_token_scopes(token.scopes) if token is not None else None
    return user


def get_session_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    return db.get(User, user_id)


def resolve_api_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User | None:
    if creds is not None and creds.scheme.lower() == "bearer":
        user, token = _load_bearer_token(creds, db)
        return _bind_principal(request, user, token)
    user = get_session_user(request, db)
    if user is None:
        return None
    return _bind_principal(request, user, None)


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
        return _bind_principal(request, user, None)
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
    user, _token = _load_bearer_token(creds, db)
    return user


def require_docs_user(
    request: Request,
    user: User | None = Depends(resolve_api_user),
    db: Session = Depends(get_db),
) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    token = getattr(request.state, "api_token", None)
    if token is not None:
        return user
    org_id = request.session.get("active_organization_id")
    if user_is_licensed(db, user, org_id):
        return user
    raise HTTPException(status_code=403, detail="unlicensed")


def require_scope(*scopes: str):
    needed = [name for name in scopes if name in API_SCOPES]
    if not needed:
        raise ValueError("require_scope needs at least one known scope")

    def dependency(
        request: Request,
        user: User | None = Depends(resolve_api_user),
        db: Session = Depends(get_db),
    ) -> User:
        if user is None:
            raise HTTPException(status_code=401, detail="Not signed in")
        token: ApiToken | None = getattr(request.state, "api_token", None)
        if token is not None:
            have = parse_token_scopes(token.scopes)
            if not any(scope in have for scope in needed):
                raise HTTPException(status_code=403, detail="Token missing scope")
            return user
        org_id = request.session.get("active_organization_id")
        if user_is_licensed(db, user, org_id):
            return user
        raise HTTPException(status_code=403, detail="unlicensed")

    return dependency
