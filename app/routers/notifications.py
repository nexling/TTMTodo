from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth0 import SESSION_ORG_KEY
from app.database import get_db
from app.deps import require_licensed
from app.models import PlanProject, User
from app.notifications import (
    CATEGORY_IDS,
    PROJECT_SCOPED,
    serialize_preferences,
    set_preference,
)
from app.orgs import get_user_context

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class PreferencePatch(BaseModel):
    category: str = Field(min_length=1, max_length=32)
    enabled: bool | None = None
    project_id: str | None = None


def _org_id(request: Request, user: User, db: Session) -> str | None:
    preferred = None
    if "session" in request.scope:
        preferred = request.session.get(SESSION_ORG_KEY)
    ctx = get_user_context(db, user.id, preferred if isinstance(preferred, str) else None)
    org = (ctx or {}).get("organization") or {}
    org_id = org.get("id")
    return org_id if isinstance(org_id, str) and org_id else None


@router.get("/preferences")
def get_preferences(
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    return serialize_preferences(db, user, _org_id(request, user, db))


@router.patch("/preferences")
def patch_preferences(
    body: PreferencePatch,
    request: Request,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    category = body.category.strip()
    if category not in CATEGORY_IDS:
        raise HTTPException(status_code=400, detail="Unknown notification category")
    project_id = (body.project_id or "").strip() or None
    if project_id:
        if category not in PROJECT_SCOPED:
            raise HTTPException(status_code=400, detail="This category cannot be set per project")
        org_id = _org_id(request, user, db)
        project = db.get(PlanProject, project_id)
        if project is None or not org_id or project.organization_id != org_id:
            raise HTTPException(status_code=404, detail="Project not found")
    elif body.enabled is None:
        raise HTTPException(status_code=400, detail="Global preference must be on or off")
    try:
        set_preference(db, user.id, category, body.enabled, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return serialize_preferences(db, user, _org_id(request, user, db))
