from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import require_licensed
from app.models import Attachment, Item, PlanProject, PlanTask, User
from app.orgs import active_membership

router = APIRouter(prefix="/api/files", tags=["files"])


@router.get("/{attachment_id}")
def get_file(
    attachment_id: str,
    download: bool = False,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    att = db.get(Attachment, attachment_id)
    if att is None:
        raise HTTPException(status_code=404, detail="File not found")
    if att.item_id:
        item = db.get(Item, att.item_id)
        if item is None or item.user_id != user.id:
            raise HTTPException(status_code=404, detail="File not found")
    elif att.plan_task_id:
        task = db.get(PlanTask, att.plan_task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="File not found")
        project = db.get(PlanProject, task.project_id)
        if project is None or active_membership(db, user.id, project.organization_id) is None:
            raise HTTPException(status_code=404, detail="File not found")
    else:
        raise HTTPException(status_code=404, detail="File not found")
    path = settings.upload_dir / att.stored_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File missing on disk")
    return FileResponse(
        path,
        media_type=att.mime_type,
        filename=att.original_name,
        content_disposition_type="attachment" if download else "inline",
    )
