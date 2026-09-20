from urllib.parse import urlencode

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse

from app.deps import get_session_user, require_licensed
from app.models import User
from app.outlook import (
    INSECURE_OAUTH_REDIRECT,
    OutlookError,
    authorization_flow,
    disconnect,
    exchange_code,
    fetch_events,
    oauth_configured,
    oauth_redirect_allowed,
    redirect_uri,
    set_calendars,
    status_payload,
)
from app.schemas import OutlookCalendarsIn, OutlookDisconnectIn, OutlookEventOut, OutlookStatusOut

router = APIRouter(tags=["outlook"])


def _settings_redirect(error: str | None = None) -> RedirectResponse:
    qs = f"?{urlencode({'outlook_error': error})}" if error else ""
    return RedirectResponse(f"/settings{qs}", status_code=303)


@router.get("/api/outlook", response_model=OutlookStatusOut)
def outlook_status(refresh: bool = False, user: User = Depends(require_licensed)):
    return OutlookStatusOut(**status_payload(user, refresh=refresh))


@router.get("/api/outlook/connect")
def outlook_connect(request: Request, user: User = Depends(require_licensed)):
    if not oauth_configured():
        raise HTTPException(
            status_code=400,
            detail="Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in .env, then restart magictodo",
        )
    base = str(request.base_url)
    redir = redirect_uri(base)
    if not oauth_redirect_allowed(base.rstrip("/")) or not oauth_redirect_allowed(redir):
        return _settings_redirect(INSECURE_OAUTH_REDIRECT)
    try:
        flow = authorization_flow(redir)
    except OutlookError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request.session["outlook_oauth_flow"] = flow
    request.session["outlook_oauth_redirect"] = redir
    return RedirectResponse(flow["auth_uri"], status_code=303)


@router.get("/api/outlook/callback")
def outlook_callback(request: Request, user: User | None = Depends(get_session_user)):
    if user is None:
        return RedirectResponse("/login", status_code=303)
    params = dict(request.query_params)
    if params.get("error"):
        return _settings_redirect(params.get("error_description") or params.get("error") or "Outlook denied access")
    flow = request.session.get("outlook_oauth_flow")
    if not isinstance(flow, dict):
        return _settings_redirect("Outlook sign-in expired. Try Connect Outlook again.")
    request.session.pop("outlook_oauth_flow", None)
    request.session.pop("outlook_oauth_redirect", None)
    try:
        exchange_code(flow, params, user=user)
    except Exception as exc:
        return _settings_redirect(str(exc))
    return _settings_redirect()


@router.post("/api/outlook/disconnect", response_model=OutlookStatusOut)
def outlook_disconnect(
    body: OutlookDisconnectIn = Body(default_factory=OutlookDisconnectIn),
    user: User = Depends(require_licensed),
):
    disconnect(user, body.account_id)
    return OutlookStatusOut(**status_payload(user))


@router.post("/api/outlook/calendars", response_model=OutlookStatusOut)
def outlook_calendars(body: OutlookCalendarsIn, user: User = Depends(require_licensed)):
    try:
        set_calendars(user, body.account_id, body.calendar_ids, body.calendar_colors)
    except OutlookError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return OutlookStatusOut(**status_payload(user))


@router.get("/api/outlook/events", response_model=list[OutlookEventOut])
def outlook_events(
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
    except OutlookError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [OutlookEventOut(**row) for row in rows]


def _parse_iso(raw: str):
    from datetime import datetime, timezone

    text = raw.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt
