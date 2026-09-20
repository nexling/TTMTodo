import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.database import get_db
from app.deps import require_token_user
from app.models import Bucket, Item, User
from app.routers.items import add_attachment, item_out, load_item
from app.schemas import InboxCaptureIn, ItemOut

router = APIRouter(prefix="/api/inbox", tags=["inbox"])


def _title_and_notes(clean_text: str | None) -> tuple[str | None, str | None]:
    if not clean_text:
        return None, None
    if "\n" in clean_text:
        first, rest = clean_text.split("\n", 1)
        return first.strip()[:500] or None, rest.strip() or None
    return clean_text[:500], None


def _source_label(source: str | None) -> str:
    return (source or "api").strip()[:32] or "api"


async def _parse_capture(request: Request) -> tuple[str | None, str, UploadFile | None]:
    ctype = (request.headers.get("content-type") or "").lower()
    if "application/json" in ctype:
        try:
            payload = InboxCaptureIn.model_validate(await request.json())
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=json.loads(exc.json())) from exc
        return payload.text, _source_label(payload.source), None

    form = await request.form()
    raw_text = form.get("text")
    raw_source = form.get("source")
    text = raw_text.strip() if isinstance(raw_text, str) else None
    source = raw_source if isinstance(raw_source, str) else "api"
    raw_image = form.get("image")
    image = raw_image if isinstance(raw_image, UploadFile) else None
    return text, _source_label(source), image


@router.post("", response_model=ItemOut)
async def capture_inbox(
    request: Request,
    user: User = Depends(require_token_user),
    db: Session = Depends(get_db),
):
    text, src, image = await _parse_capture(request)
    clean_text = (text or "").strip() or None
    has_image = image is not None and bool(image.filename)
    if not clean_text and not has_image:
        raise HTTPException(status_code=400, detail="Provide text or an image")

    inbox = db.scalar(
        select(Bucket).where(Bucket.user_id == user.id, Bucket.is_inbox.is_(True))
    )
    if inbox is None:
        raise HTTPException(status_code=500, detail="Inbox missing")

    title, notes = _title_and_notes(clean_text)
    item = Item(
        user_id=user.id,
        bucket_id=inbox.id,
        title=title,
        notes=notes,
        source=src,
        status="open",
    )
    db.add(item)
    db.flush()
    if has_image and image is not None:
        add_attachment(db, item, image)
    db.commit()
    return item_out(load_item(db, user, item.id))
