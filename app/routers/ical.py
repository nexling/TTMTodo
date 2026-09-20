from fastapi import APIRouter, Depends, HTTPException, Query

from app.deps import require_licensed
from app.ical import IcalError, add_feed, delete_feed, fetch_events, patch_feed, status_payload
from app.models import User
from app.schemas import IcalFeedIn, IcalFeedPatchIn, IcalStatusOut, OutlookEventOut

router = APIRouter(tags=["ical"])


def _parse_iso(raw: str):
    from datetime import datetime, timezone

    text = raw.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


@router.get("/api/ical", response_model=IcalStatusOut)
def ical_status(user: User = Depends(require_licensed)):
    return IcalStatusOut(**status_payload(user))


@router.post("/api/ical/feeds", response_model=IcalStatusOut)
def ical_add_feed(body: IcalFeedIn, user: User = Depends(require_licensed)):
    try:
        return IcalStatusOut(**add_feed(user, label=body.label, url=body.url, color=body.color))
    except IcalError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/api/ical/feeds/{feed_id}", response_model=IcalStatusOut)
def ical_patch_feed(feed_id: str, body: IcalFeedPatchIn, user: User = Depends(require_licensed)):
    try:
        return IcalStatusOut(
            **patch_feed(
                user,
                feed_id,
                {"label": body.label, "url": body.url, "color": body.color},
            )
        )
    except IcalError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/api/ical/feeds/{feed_id}", response_model=IcalStatusOut)
def ical_delete_feed(feed_id: str, user: User = Depends(require_licensed)):
    try:
        return IcalStatusOut(**delete_feed(user, feed_id))
    except IcalError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/ical/events", response_model=list[OutlookEventOut])
def ical_events(
    start: str = Query(min_length=8, max_length=40),
    end: str = Query(min_length=8, max_length=40),
    user: User = Depends(require_licensed),
):
    try:
        start_dt = _parse_iso(start)
        end_dt = _parse_iso(end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid start or end time") from exc
    try:
        rows = fetch_events(user, start_dt, end_dt)
    except IcalError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [OutlookEventOut(**row) for row in rows]
