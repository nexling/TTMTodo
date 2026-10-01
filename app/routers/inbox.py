from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.database import get_db
from app.deps import require_scope
from app.items import create_item, item_out, load_item
from app.models import User
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
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=exc.errors()) from exc
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc
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
    user: User = Depends(require_scope("inbox")),
    db: Session = Depends(get_db),
):
    text, src, image = await _parse_capture(request)
    clean_text = (text or "").strip() or None
    has_image = image is not None and bool(image.filename)
    if not clean_text and not has_image:
        raise HTTPException(status_code=400, detail="Provide text or an image")

    title, notes = _title_and_notes(clean_text)
    uploads = [image] if has_image and image is not None else []
    item = create_item(
        db,
        user,
        title=title,
        notes=notes,
        source=src,
        uploads=uploads,
    )
    db.commit()
    return item_out(load_item(db, user, item.id))
