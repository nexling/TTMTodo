from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_session_user, require_licensed
from app.google_lists import (
    GoogleListsError,
    INSECURE_OAUTH_REDIRECT,
    connect_keep,
    disconnect_keep,
    disconnect_tasks,
    oauth_authorization_url,
    oauth_exchange,
    oauth_redirect_allowed,
    pull,
    redirect_uri,
    set_keep_lists,
    set_tasks_list,
    status_payload,
    tasks_oauth_configured,
)
from app.models import User
from app.schemas import GoogleKeepConnectIn, GoogleKeepListsIn, GoogleStatusOut, GoogleTasksListIn

router = APIRouter(tags=["google"])


def _settings_redirect(error: str | None = None) -> RedirectResponse:
    qs = f"?{urlencode({'google_error': error})}" if error else ""
    return RedirectResponse(f"/settings{qs}", status_code=303)


@router.get("/api/google", response_model=GoogleStatusOut)
def google_status(refresh: bool = False, user: User = Depends(require_licensed)):
    return GoogleStatusOut(**status_payload(user, refresh=refresh))


@router.get("/api/google/tasks/connect")
def google_tasks_connect(request: Request, user: User = Depends(require_licensed)):
    if not tasks_oauth_configured():
        raise HTTPException(
            status_code=400,
            detail="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart magictodo",
        )
    base = str(request.base_url)
    redir = redirect_uri(base)
    if not oauth_redirect_allowed(base.rstrip("/")) or not oauth_redirect_allowed(redir):
        return _settings_redirect(INSECURE_OAUTH_REDIRECT)
    try:
        url, state, code_verifier = oauth_authorization_url(redir)
    except GoogleListsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request.session["google_oauth_state"] = state
    request.session["google_oauth_redirect"] = redir
    request.session["google_oauth_verifier"] = code_verifier
    return RedirectResponse(url, status_code=303)


@router.get("/api/google/callback")
def google_callback(request: Request, user: User | None = Depends(get_session_user)):
    if user is None:
        return RedirectResponse("/login", status_code=303)
    params = request.query_params
    if params.get("error"):
        return _settings_redirect(params.get("error_description") or params.get("error") or "Google denied access")
    expected = request.session.get("google_oauth_state")
    redir = request.session.get("google_oauth_redirect") or redirect_uri(str(request.base_url))
    verifier = request.session.get("google_oauth_verifier") or ""
    state = params.get("state")
    if not expected or not state or state != expected:
        return _settings_redirect("Google sign-in expired. Try Connect Tasks again.")
    request.session.pop("google_oauth_state", None)
    request.session.pop("google_oauth_redirect", None)
    request.session.pop("google_oauth_verifier", None)
    try:
        oauth_exchange(redir, str(request.url), verifier, user=user)
    except Exception as exc:
        return _settings_redirect(str(exc))
    return _settings_redirect()


@router.post("/api/google/tasks/disconnect")
def google_tasks_disconnect(user: User = Depends(require_licensed)):
    disconnect_tasks(user)
    return GoogleStatusOut(**status_payload(user))


@router.post("/api/google/tasks/list", response_model=GoogleStatusOut)
def google_tasks_list(body: GoogleTasksListIn, user: User = Depends(require_licensed)):
    try:
        set_tasks_list(user, body.list_id.strip())
    except GoogleListsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GoogleStatusOut(**status_payload(user))


@router.post("/api/google/keep/connect", response_model=GoogleStatusOut)
def google_keep_connect(body: GoogleKeepConnectIn, user: User = Depends(require_licensed)):
    try:
        connect_keep(user, body.email, body.master_token)
    except GoogleListsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GoogleStatusOut(**status_payload(user))


@router.post("/api/google/keep/disconnect")
def google_keep_disconnect(user: User = Depends(require_licensed)):
    disconnect_keep(user)
    return GoogleStatusOut(**status_payload(user))


@router.post("/api/google/keep/lists", response_model=GoogleStatusOut)
def google_keep_lists(body: GoogleKeepListsIn, user: User = Depends(require_licensed)):
    try:
        set_keep_lists(user, body.note_ids, watch_all=body.watch_all)
    except GoogleListsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GoogleStatusOut(**status_payload(user))


@router.post("/api/google/sync", response_model=GoogleStatusOut)
def google_sync(user: User = Depends(require_licensed), db: Session = Depends(get_db)):
    pull(db, user)
    return GoogleStatusOut(**status_payload(user))
