from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_licensed
from app.ical_export import (
    build_calendar,
    disable_feed,
    enable_feed,
    find_user_for_token,
    rotate_feed,
    status_payload,
)
from app.models import User
from app.schemas import CalendarExportStatusOut

router = APIRouter(tags=["calendar-export"])


def _ics_response(body: bytes) -> Response:
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": 'inline; filename="ttm-todo.ics"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/api/calendar/export", response_model=CalendarExportStatusOut)
def calendar_export_status(user: User = Depends(require_licensed)):
    return CalendarExportStatusOut(**status_payload(user))


@router.post("/api/calendar/export", response_model=CalendarExportStatusOut)
def calendar_export_enable(user: User = Depends(require_licensed)):
    return CalendarExportStatusOut(**enable_feed(user))


@router.post("/api/calendar/export/regenerate", response_model=CalendarExportStatusOut)
def calendar_export_regenerate(user: User = Depends(require_licensed)):
    return CalendarExportStatusOut(**rotate_feed(user))


@router.delete("/api/calendar/export", response_model=CalendarExportStatusOut)
def calendar_export_disable(user: User = Depends(require_licensed)):
    return CalendarExportStatusOut(**disable_feed(user))


@router.get("/api/calendar/feed/{token}")
def calendar_feed(token: str, db: Session = Depends(get_db)):
    user = find_user_for_token(db, token)
    if user is None:
        raise HTTPException(status_code=404, detail="Calendar feed not found")
    return _ics_response(build_calendar(db, user))
