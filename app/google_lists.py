from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Iterator
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Bucket, GoogleImport, Item, User
from app.routers.items import next_sort_order
from app.userfiles import google_config_path, google_status_path

log = logging.getLogger("magictodo")

TASKS_SCOPE = "https://www.googleapis.com/auth/tasks"
DEFAULT_KEEP_TITLES = frozenset({"shopping list", "shopping", "magictodo", "ttm-todo", "ttm todo"})
PROVIDER_TASKS = "tasks"
PROVIDER_KEEP = "keep"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
INSECURE_OAUTH_REDIRECT = (
    "Google blocks HTTP OAuth except on 127.0.0.1. From Windows run "
    "ssh -L 8010:127.0.0.1:8010 nexserve, open http://127.0.0.1:8010/settings, "
    "then Connect Tasks. Register http://127.0.0.1:8010/api/google/callback "
    "on the NexApp Web client — not the Tailscale http URL."
)


class GoogleListsError(Exception):
    pass


_google_user: ContextVar[User | None] = ContextVar("google_user", default=None)


@contextmanager
def acting_as(user: User) -> Iterator[User]:
    token = _google_user.set(user)
    try:
        yield user
    finally:
        _google_user.reset(token)


def _user() -> User:
    user = _google_user.get()
    if user is None:
        raise GoogleListsError("Google config needs a signed-in user")
    return user


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _empty_config() -> dict[str, Any]:
    return {
        "tasks": {
            "token": "",
            "refresh_token": "",
            "expiry": "",
            "list_id": "",
            "list_title": "",
            "cached_lists": [],
        },
        "keep": {
            "email": "",
            "master_token": "",
            "device_id": "",
            "note_ids": [],
            "watch_all": False,
            "cached_lists": [],
        },
    }


def load_config() -> dict[str, Any]:
    path = google_config_path(_user().id)
    base = _empty_config()
    if not path.is_file():
        return base
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return base
    if not isinstance(raw, dict):
        return base
    for key in ("tasks", "keep"):
        if isinstance(raw.get(key), dict):
            base[key].update(raw[key])
    return base


def save_config(cfg: dict[str, Any]) -> None:
    path = google_config_path(_user().id)
    path.write_text(json.dumps(cfg, indent=2))
    path.chmod(0o600)


def load_status() -> dict[str, Any]:
    path = google_status_path(_user().id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_status(payload: dict[str, Any]) -> None:
    path = google_status_path(_user().id)
    path.write_text(json.dumps(payload, indent=2))
    path.chmod(0o600)


def tasks_oauth_configured() -> bool:
    return bool(settings.google_client_id.strip() and settings.google_client_secret.strip())


def tasks_connected() -> bool:
    return bool(load_config()["tasks"].get("refresh_token"))


def keep_connected() -> bool:
    cfg = load_config()["keep"]
    return bool(str(cfg.get("email") or "").strip() and str(cfg.get("master_token") or "").strip())


def redirect_uri(request_base: str | None = None) -> str:
    explicit = settings.google_redirect_uri.strip()
    if explicit:
        return explicit.rstrip("/")
    if request_base:
        return request_base.rstrip("/") + "/api/google/callback"
    return f"http://127.0.0.1:{settings.port}/api/google/callback"


def oauth_redirect_allowed(uri: str) -> bool:
    parsed = urlparse(uri)
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and host:
        return True
    return parsed.scheme == "http" and host in LOOPBACK_HOSTS


def _allow_http_oauth() -> None:
    os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")
    os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")


def _client_config(redir: str) -> dict[str, Any]:
    if not tasks_oauth_configured():
        raise GoogleListsError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set")
    return {
        "web": {
            "client_id": settings.google_client_id.strip(),
            "client_secret": settings.google_client_secret.strip(),
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [redir],
        }
    }


def oauth_authorization_url(redir: str) -> tuple[str, str, str]:
    from google_auth_oauthlib.flow import Flow

    _allow_http_oauth()
    flow = Flow.from_client_config(_client_config(redir), scopes=[TASKS_SCOPE], redirect_uri=redir)
    url, state = flow.authorization_url(
        access_type="offline",
        prompt="consent",
    )
    return url, state, flow.code_verifier or ""


def oauth_exchange(
    redir: str,
    authorization_response: str,
    code_verifier: str | None = None,
    *,
    user: User,
) -> None:
    from google_auth_oauthlib.flow import Flow

    with acting_as(user):
        _allow_http_oauth()
        flow = Flow.from_client_config(_client_config(redir), scopes=[TASKS_SCOPE], redirect_uri=redir)
        if code_verifier:
            flow.code_verifier = code_verifier
            flow.autogenerate_code_verifier = False
        flow.fetch_token(authorization_response=authorization_response)
        _store_tasks_creds(flow.credentials)
        try:
            lists = fetch_tasks_lists()
            _apply_tasks_lists(lists, auto_pick=True)
        except Exception as exc:
            log.warning("Could not list Google Tasks after OAuth: %s", exc)


def disconnect_tasks(user: User) -> None:
    with acting_as(user):
        cfg = load_config()
        cfg["tasks"] = _empty_config()["tasks"]
        save_config(cfg)


def ensure_keep_device_id(user: User) -> str:
    """Stable Android id for gpsoauth and gkeepapi. Changing it invalidates the master token."""
    with acting_as(user):
        return _keep_device_id()


def _keep_device_id() -> str:
    cfg = load_config()
    device_id = str(cfg["keep"].get("device_id") or "").strip()
    if not device_id:
        device_id = uuid.uuid4().hex[:16]
        cfg["keep"]["device_id"] = device_id
        save_config(cfg)
    return device_id


def disconnect_keep(user: User) -> None:
    with acting_as(user):
        cfg = load_config()
        device_id = cfg["keep"].get("device_id") or ""
        cfg["keep"] = _empty_config()["keep"]
        cfg["keep"]["device_id"] = device_id
        save_config(cfg)


def connect_keep(user: User, email: str, master_token: str) -> None:
    email = email.strip()
    master_token = master_token.strip()
    if "@" not in email:
        raise GoogleListsError("Keep email looks invalid")
    with acting_as(user):
        device_id = _keep_device_id()
        cfg = load_config()
        cfg["keep"]["email"] = email
        cfg["keep"]["master_token"] = master_token
        cfg["keep"]["device_id"] = device_id
        cfg["keep"]["note_ids"] = []
        cfg["keep"]["watch_all"] = False
        cfg["keep"]["cached_lists"] = []
        save_config(cfg)
        try:
            lists = fetch_keep_lists()
        except Exception as exc:
            cfg = load_config()
            kept_id = cfg["keep"].get("device_id") or ""
            cfg["keep"] = _empty_config()["keep"]
            cfg["keep"]["device_id"] = kept_id
            save_config(cfg)
            raise GoogleListsError(f"Keep login failed: {exc}") from exc
        _apply_keep_lists(lists, auto_pick=True)


def set_tasks_list(user: User, list_id: str) -> None:
    with acting_as(user):
        lists = fetch_tasks_lists()
        match = next((row for row in lists if row["id"] == list_id), None)
        if match is None:
            raise GoogleListsError("That Tasks list was not found")
        cfg = load_config()
        cfg["tasks"]["list_id"] = match["id"]
        cfg["tasks"]["list_title"] = match["title"]
        cfg["tasks"]["cached_lists"] = lists
        save_config(cfg)


def set_keep_lists(user: User, note_ids: list[str], watch_all: bool = False) -> None:
    wanted = [nid.strip() for nid in note_ids if nid and nid.strip()]
    with acting_as(user):
        lists = fetch_keep_lists()
        if watch_all:
            wanted = [row["id"] for row in lists]
        else:
            known = {row["id"] for row in lists}
            missing = [nid for nid in wanted if nid not in known]
            if missing:
                raise GoogleListsError("One or more Keep lists were not found")
        cfg = load_config()
        cfg["keep"]["watch_all"] = bool(watch_all)
        cfg["keep"]["note_ids"] = wanted
        cfg["keep"]["cached_lists"] = lists
        save_config(cfg)


def _expiry_to_google(dt: datetime) -> str:
    """google-auth parses expiry with strptime('%Y-%m-%dT%H:%M:%S') after stripping Z."""
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.replace(microsecond=0).isoformat() + "Z"


def _expiry_from_storage(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw
    return _expiry_to_google(dt)


def _store_tasks_creds(creds: Any) -> None:
    cfg = load_config()
    expiry = ""
    if getattr(creds, "expiry", None):
        expiry = _expiry_to_google(creds.expiry)
    refresh = creds.refresh_token or cfg["tasks"].get("refresh_token") or ""
    cfg["tasks"]["token"] = creds.token or ""
    cfg["tasks"]["refresh_token"] = refresh
    cfg["tasks"]["expiry"] = expiry
    save_config(cfg)


def _tasks_credentials():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    cfg = load_config()["tasks"]
    if not cfg.get("refresh_token"):
        return None
    if not tasks_oauth_configured():
        raise GoogleListsError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set")
    info = {
        "token": cfg.get("token") or None,
        "refresh_token": cfg["refresh_token"],
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": settings.google_client_id.strip(),
        "client_secret": settings.google_client_secret.strip(),
        "scopes": [TASKS_SCOPE],
    }
    stored_expiry = _expiry_from_storage(str(cfg.get("expiry") or ""))
    if stored_expiry:
        info["expiry"] = stored_expiry
    creds = Credentials.from_authorized_user_info(info, [TASKS_SCOPE])
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        _store_tasks_creds(creds)
    elif stored_expiry != str(cfg.get("expiry") or "").strip():
        _store_tasks_creds(creds)
    return creds


def _tasks_service():
    from googleapiclient.discovery import build

    creds = _tasks_credentials()
    if creds is None:
        raise GoogleListsError("Google Tasks is not connected")
    return build("tasks", "v1", credentials=creds, cache_discovery=False)


def fetch_tasks_lists() -> list[dict[str, str]]:
    service = _tasks_service()
    rows: list[dict[str, str]] = []
    page = None
    while True:
        resp = service.tasklists().list(maxResults=100, pageToken=page).execute()
        for item in resp.get("items") or []:
            tid = str(item.get("id") or "")
            if not tid:
                continue
            rows.append({"id": tid, "title": str(item.get("title") or "Untitled").strip() or "Untitled"})
        page = resp.get("nextPageToken")
        if not page:
            break
    return rows


def _apply_tasks_lists(lists: list[dict[str, str]], *, auto_pick: bool) -> None:
    cfg = load_config()
    cfg["tasks"]["cached_lists"] = lists
    current = cfg["tasks"].get("list_id") or ""
    if current and any(row["id"] == current for row in lists):
        title = next(row["title"] for row in lists if row["id"] == current)
        cfg["tasks"]["list_title"] = title
        save_config(cfg)
        return
    if auto_pick or not current:
        titles = {row["title"].strip().casefold(): row for row in lists}
        picked = (
            titles.get("ttm-todo")
            or titles.get("ttm todo")
            or titles.get("magictodo")
            or (lists[0] if lists else None)
        )
        if picked:
            cfg["tasks"]["list_id"] = picked["id"]
            cfg["tasks"]["list_title"] = picked["title"]
    save_config(cfg)


def _keep_client():
    import gkeepapi

    cfg = load_config()
    email = str(cfg["keep"].get("email") or "").strip()
    token = str(cfg["keep"].get("master_token") or "").strip()
    if not email or not token:
        raise GoogleListsError("Google Keep is not connected")
    device_id = _keep_device_id()
    keep = gkeepapi.Keep()
    try:
        keep.authenticate(email, token, sync=True, device_id=device_id)
    except TypeError:
        keep.authenticate(email, token)
    return keep


def _is_keep_list(note: Any) -> bool:
    try:
        from gkeepapi.node import List as KeepList
    except ImportError:
        KeepList = None  # type: ignore[misc, assignment]
    if KeepList is not None and isinstance(note, KeepList):
        return True
    return type(note).__name__ == "List" and hasattr(note, "unchecked")


def _keep_note_alive(note: Any) -> bool:
    if getattr(note, "trashed", False) or getattr(note, "deleted", False):
        return False
    if getattr(note, "archived", False):
        return False
    return True


def fetch_keep_lists() -> list[dict[str, str]]:
    keep = _keep_client()
    rows: list[dict[str, str]] = []
    for note in keep.all():
        if not _is_keep_list(note) or not _keep_note_alive(note):
            continue
        nid = str(getattr(note, "id", "") or "")
        if not nid:
            continue
        title = str(getattr(note, "title", "") or "").strip() or "(untitled list)"
        rows.append({"id": nid, "title": title})
    rows.sort(key=lambda row: row["title"].casefold())
    return rows


def _apply_keep_lists(lists: list[dict[str, str]], *, auto_pick: bool) -> None:
    cfg = load_config()
    cfg["keep"]["cached_lists"] = lists
    if cfg["keep"].get("watch_all"):
        cfg["keep"]["note_ids"] = [row["id"] for row in lists]
        save_config(cfg)
        return
    stored = [nid for nid in (cfg["keep"].get("note_ids") or []) if nid]
    known = {row["id"] for row in lists}
    stored = [nid for nid in stored if nid in known]
    if auto_pick and not stored:
        stored = [
            row["id"]
            for row in lists
            if row["title"].strip().casefold() in DEFAULT_KEEP_TITLES
        ]
    cfg["keep"]["note_ids"] = stored
    save_config(cfg)


def _selected_keep_ids(cfg: dict[str, Any], lists: list[dict[str, str]]) -> set[str]:
    if cfg["keep"].get("watch_all"):
        return {row["id"] for row in lists}
    stored = [nid for nid in (cfg["keep"].get("note_ids") or []) if nid]
    if stored:
        return set(stored)
    return {row["id"] for row in lists if row["title"].strip().casefold() in DEFAULT_KEEP_TITLES}


def _inbox(db: Session, user: User) -> Bucket:
    inbox = db.scalar(select(Bucket).where(Bucket.user_id == user.id, Bucket.is_inbox.is_(True)))
    if inbox is None:
        raise GoogleListsError("Inbox missing")
    return inbox


def _remote_key(raw: str) -> str:
    raw = raw.strip()
    if len(raw) <= 160:
        return raw
    return hashlib.sha256(raw.encode()).hexdigest()


def _already(db: Session, user: User, provider: str, remote_id: str) -> bool:
    return (
        db.scalar(
            select(GoogleImport.id).where(
                GoogleImport.user_id == user.id,
                GoogleImport.provider == provider,
                GoogleImport.remote_id == remote_id,
            )
        )
        is not None
    )


def import_line(
    db: Session,
    user: User,
    *,
    provider: str,
    remote_id: str,
    title: str,
    notes: str | None = None,
    source: str,
) -> str:
    """Create an Inbox item. Returns imported or skipped."""
    title = title.strip()
    if not title:
        return "skipped"
    key = _remote_key(remote_id)
    if _already(db, user, provider, key):
        return "skipped"
    inbox = _inbox(db, user)
    try:
        with db.begin_nested():
            item = Item(
                user_id=user.id,
                bucket_id=inbox.id,
                title=title[:500],
                notes=(notes.strip() if notes else None) or None,
                source=source[:32],
                status="open",
                sort_order=next_sort_order(db, user, inbox.id, None, prepend=True),
            )
            db.add(item)
            db.flush()
            db.add(
                GoogleImport(
                    user_id=user.id,
                    provider=provider,
                    remote_id=key,
                    item_id=item.id,
                )
            )
            db.flush()
    except IntegrityError:
        return "skipped"
    return "imported"


def _iter_open_tasks(service: Any, list_id: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    page = None
    while True:
        resp = (
            service.tasks()
            .list(
                tasklist=list_id,
                showCompleted=False,
                showHidden=False,
                maxResults=100,
                pageToken=page,
            )
            .execute()
        )
        for task in resp.get("items") or []:
            if str(task.get("status") or "") == "completed":
                continue
            tid = str(task.get("id") or "")
            title = str(task.get("title") or "").strip()
            if not tid or not title:
                continue
            rows.append(
                {
                    "id": tid,
                    "title": title,
                    "notes": str(task.get("notes") or "").strip(),
                }
            )
        page = resp.get("nextPageToken")
        if not page:
            break
    return rows


def _pull_tasks(db: Session, user: User, bucket: dict[str, Any]) -> None:
    service = _tasks_service()
    lists = fetch_tasks_lists()
    _apply_tasks_lists(lists, auto_pick=False)
    if not lists:
        raise GoogleListsError("No Google Tasks lists found")
    to_complete: list[tuple[str, str]] = []
    for task_list in lists:
        list_id = task_list["id"]
        for task in _iter_open_tasks(service, list_id):
            tid = task["id"]
            remote_id = f"{list_id}:{tid}"
            if _already(db, user, PROVIDER_TASKS, _remote_key(tid)) or _already(
                db, user, PROVIDER_TASKS, _remote_key(remote_id)
            ):
                bucket["skipped"] += 1
                to_complete.append((list_id, tid))
                continue
            outcome = import_line(
                db,
                user,
                provider=PROVIDER_TASKS,
                remote_id=remote_id,
                title=task["title"],
                notes=task["notes"] or None,
                source="google-tasks",
            )
            if outcome == "imported":
                bucket["imported"] += 1
            else:
                bucket["skipped"] += 1
            to_complete.append((list_id, tid))
    db.commit()
    for list_id, tid in to_complete:
        try:
            service.tasks().patch(
                tasklist=list_id,
                task=tid,
                body={"status": "completed"},
            ).execute()
        except Exception as exc:
            log.warning("Could not complete Google Task %s: %s", tid, exc)


def _keep_item_id(note: Any, item: Any) -> str:
    note_id = str(getattr(note, "id", "") or "note")
    item_id = str(getattr(item, "id", "") or "")
    text = str(getattr(item, "text", "") or "")
    if item_id:
        return f"{note_id}:{item_id}"
    digest = hashlib.sha256(f"{note_id}:{text}".encode()).hexdigest()
    return f"{note_id}:{digest}"


def _pull_keep(db: Session, user: User, bucket: dict[str, Any]) -> None:
    keep = _keep_client()
    cfg = load_config()
    lists = []
    for note in keep.all():
        if not _is_keep_list(note) or not _keep_note_alive(note):
            continue
        nid = str(getattr(note, "id", "") or "")
        if not nid:
            continue
        lists.append({"id": nid, "title": str(getattr(note, "title", "") or "").strip() or "(untitled list)"})
    selected = _selected_keep_ids(cfg, lists)
    if not selected:
        raise GoogleListsError("No Keep lists selected (connect Shopping list, TTM-Todo, or MagicTODO)")
    changed = False
    for note in keep.all():
        if not _is_keep_list(note) or not _keep_note_alive(note):
            continue
        nid = str(getattr(note, "id", "") or "")
        if nid not in selected:
            continue
        unchecked = list(getattr(note, "unchecked", None) or [])
        for item in unchecked:
            text = str(getattr(item, "text", "") or "").strip()
            if not text:
                continue
            remote_id = _keep_item_id(note, item)
            outcome = import_line(
                db,
                user,
                provider=PROVIDER_KEEP,
                remote_id=remote_id,
                title=text,
                source="google-keep",
            )
            if outcome == "imported":
                bucket["imported"] += 1
            else:
                bucket["skipped"] += 1
            try:
                item.checked = True
                changed = True
            except Exception as exc:
                log.warning("Could not check off Keep item: %s", exc)
    db.commit()
    cfg = load_config()
    cfg["keep"]["cached_lists"] = lists
    save_config(cfg)
    if changed:
        try:
            keep.sync()
        except Exception as exc:
            log.warning("Keep sync after check-off failed: %s", exc)


def _source_status(
    *,
    configured: bool,
    connected: bool,
    label: str,
    lists: list[dict[str, str]],
    selected: set[str],
    last: dict[str, Any],
    watch_all: bool = False,
) -> dict[str, Any]:
    return {
        "configured": configured,
        "connected": connected,
        "label": label,
        "imported": int(last.get("imported") or 0),
        "skipped": int(last.get("skipped") or 0),
        "error": last.get("error"),
        "watch_all": bool(watch_all),
        "lists": [
            {"id": row["id"], "title": row["title"], "selected": row["id"] in selected}
            for row in lists
        ],
    }


def status_payload(user: User, *, refresh: bool = False) -> dict[str, Any]:
    with acting_as(user):
        last = load_status()
        cfg = load_config()
        tasks_lists = list(cfg["tasks"].get("cached_lists") or [])
        keep_lists = list(cfg["keep"].get("cached_lists") or [])
        tasks_err = (last.get("tasks") or {}).get("error")
        keep_err = (last.get("keep") or {}).get("error")

        if refresh and tasks_connected():
            try:
                tasks_lists = fetch_tasks_lists()
                _apply_tasks_lists(tasks_lists, auto_pick=not bool(cfg["tasks"].get("list_id")))
                cfg = load_config()
                tasks_lists = list(cfg["tasks"].get("cached_lists") or tasks_lists)
            except Exception as exc:
                tasks_err = str(exc)
                log.warning("Google Tasks list refresh failed: %s", exc)

        if refresh and keep_connected():
            try:
                keep_lists = fetch_keep_lists()
                _apply_keep_lists(keep_lists, auto_pick=not bool(cfg["keep"].get("note_ids")))
                cfg = load_config()
                keep_lists = list(cfg["keep"].get("cached_lists") or keep_lists)
            except Exception as exc:
                keep_err = str(exc)
                log.warning("Google Keep list refresh failed: %s", exc)

        tasks_selected = {row["id"] for row in tasks_lists}
        keep_selected = _selected_keep_ids(cfg, keep_lists)
        tasks_label = "all lists" if tasks_connected() and tasks_lists else str(cfg["tasks"].get("list_title") or "").strip()
        keep_label = str(cfg["keep"].get("email") or "").strip()

        payload = {
            "tasks": _source_status(
                configured=tasks_oauth_configured(),
                connected=tasks_connected(),
                label=tasks_label,
                lists=tasks_lists,
                selected=tasks_selected,
                last=last.get("tasks") or {},
            ),
            "keep": _source_status(
                configured=True,
                connected=keep_connected(),
                label=keep_label,
                lists=keep_lists,
                selected=keep_selected,
                last=last.get("keep") or {},
                watch_all=bool(cfg["keep"].get("watch_all")),
            ),
            "last_at": last.get("at"),
            "last_ok": last.get("ok"),
            "error": last.get("error"),
        }
        if tasks_err and payload["tasks"]["error"] is None:
            payload["tasks"]["error"] = tasks_err
        if keep_err and payload["keep"]["error"] is None:
            payload["keep"]["error"] = keep_err
        return payload


def pull(db: Session, user: User) -> dict[str, Any]:
    with acting_as(user):
        result: dict[str, Any] = {
            "at": _utcnow().isoformat(),
            "ok": True,
            "error": None,
            "tasks": {"imported": 0, "skipped": 0, "error": None},
            "keep": {"imported": 0, "skipped": 0, "error": None},
        }
        tasks_on = tasks_connected()
        keep_on = keep_connected()
        if not tasks_on and not keep_on:
            result["ok"] = True
            result["error"] = None
            save_status(result)
            return result

        if tasks_on:
            try:
                _pull_tasks(db, user, result["tasks"])
            except Exception as exc:
                log.exception("Google Tasks pull failed")
                result["tasks"]["error"] = str(exc)
                try:
                    db.rollback()
                except Exception:
                    pass
        if keep_on:
            try:
                _pull_keep(db, user, result["keep"])
            except Exception as exc:
                log.exception("Google Keep pull failed")
                result["keep"]["error"] = str(exc)
                try:
                    db.rollback()
                except Exception:
                    pass

        errors = [result["tasks"]["error"], result["keep"]["error"]]
        errors = [e for e in errors if e]
        if errors:
            result["ok"] = False
            result["error"] = " · ".join(errors)
        save_status(result)
        return result


def cli_pull() -> int:
    from app.bootstrap import bootstrap
    from app.database import SessionLocal

    bootstrap()
    any_connected = False
    failed = False
    with SessionLocal() as db:
        users = list(db.scalars(select(User).order_by(User.created_at.asc())).all())
        if not users:
            print("No TTM-Todo user yet")
            return 1
        for user in users:
            with acting_as(user):
                if not tasks_connected() and not keep_connected():
                    continue
                any_connected = True
                try:
                    result = pull(db, user)
                except Exception as exc:
                    print(f"{user.username}: {exc}")
                    failed = True
                    continue
            tasks = result.get("tasks") or {}
            keep = result.get("keep") or {}
            print(
                "{name}: tasks imported={ti} skipped={ts} keep imported={ki} skipped={ks}".format(
                    name=user.username,
                    ti=tasks.get("imported", 0),
                    ts=tasks.get("skipped", 0),
                    ki=keep.get("imported", 0),
                    ks=keep.get("skipped", 0),
                )
            )
            if result.get("error") and not result.get("ok"):
                print(f"{user.username}: {result['error']}")
                failed = True
    if not any_connected:
        print("Neither Google Tasks nor Keep is connected")
        return 0
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(cli_pull())
