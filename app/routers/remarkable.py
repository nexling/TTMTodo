from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_licensed
from app.models import User
from app.remarkable import RemarkableError, pull, push_item, save_connection, status_payload
from app.schemas import RemarkablePushOut, RemarkableSettingsIn, RemarkableStatusOut

router = APIRouter(tags=["remarkable"])


@router.get("/api/remarkable", response_model=RemarkableStatusOut)
def remarkable_status(user: User = Depends(require_licensed)):
    return RemarkableStatusOut(**status_payload(user))


@router.post("/api/remarkable/settings", response_model=RemarkableStatusOut)
def remarkable_settings(body: RemarkableSettingsIn, user: User = Depends(require_licensed)):
    return RemarkableStatusOut(
        **save_connection(
            user,
            host=body.host,
            ssh_user=body.user,
            port=body.port,
            folder=body.folder,
            out_folder=body.out_folder,
            key_path=body.key_path,
            private_key=body.private_key,
        )
    )


@router.post("/api/remarkable/sync", response_model=RemarkableStatusOut)
def remarkable_sync(user: User = Depends(require_licensed), db: Session = Depends(get_db)):
    result = pull(db, user)
    payload = status_payload(user)
    if result.get("error") and not result.get("ok"):
        raise HTTPException(status_code=400, detail=result["error"])
    return RemarkableStatusOut(**payload)


@router.post("/api/items/{item_id}/remarkable", response_model=RemarkablePushOut)
def send_to_remarkable(
    item_id: str,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    try:
        result = push_item(db, user, item_id)
    except RemarkableError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return RemarkablePushOut(**result)
