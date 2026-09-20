from __future__ import annotations

import hmac
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from icalendar import Alarm, Calendar, Event
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.models import Item, User
from app.orgs import user_is_licensed
from app.security import hash_token
from app.userfiles import calendar_export_path

log = logging.getLogger("magictodo.ical_export")

TASK_MINUTES = 30
TOKEN_PREFIX = "mtcal_"
RRULE_FREQ = {"day": "DAILY", "week": "WEEKLY", "month": "MONTHLY", "year": "YEARLY"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _empty_config() -> dict[str, Any]:
    return {"token": "", "token_hash": ""}


def load_config(user_id: str) -> dict[str, Any]:
    path = calendar_export_path(user_id)
    if not path.is_file():
        return _empty_config()
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return _empty_config()
    if not isinstance(raw, dict):
        return _empty_config()
    token = str(raw.get("token") or "").strip()
    stored_hash = str(raw.get("token_hash") or "").strip()
    if token and not stored_hash:
        stored_hash = hash_token(token)
    if stored_hash and not token:
        return _empty_config()
    return {"token": token, "token_hash": stored_hash}


def save_config(user_id: str, cfg: dict[str, Any]) -> None:
    path = calendar_export_path(user_id)
    path.write_text(json.dumps(cfg, indent=2))
    path.chmod(0o600)


def delete_config(user_id: str) -> None:
    path = calendar_export_path(user_id)
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def feed_path(token: str) -> str:
    return f"/api/calendar/feed/{token}.ics"


def _new_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def status_payload(user: User) -> dict[str, Any]:
    cfg = load_config(user.id)
    token = cfg.get("token") or ""
    if not token or not cfg.get("token_hash"):
        return {"enabled": False, "path": None}
    return {"enabled": True, "path": feed_path(token)}


def enable_feed(user: User) -> dict[str, Any]:
    cfg = load_config(user.id)
    if cfg.get("token") and cfg.get("token_hash"):
        return status_payload(user)
    return rotate_feed(user)


def rotate_feed(user: User) -> dict[str, Any]:
    token = _new_token()
    save_config(user.id, {"token": token, "token_hash": hash_token(token)})
    return {"enabled": True, "path": feed_path(token)}


def disable_feed(user: User) -> dict[str, Any]:
    delete_config(user.id)
    return {"enabled": False, "path": None}


def find_user_for_token(db: Session, token: str) -> User | None:
    raw = (token or "").strip()
    if raw.endswith(".ics"):
        raw = raw[:-4]
    if not raw.startswith(TOKEN_PREFIX):
        return None
    wanted = hash_token(raw)
    users_dir = settings.data_dir / "users"
    if not users_dir.is_dir():
        return None
    for path in users_dir.glob("*/calendar_export.json"):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        stored = str(data.get("token_hash") or "").strip()
        if not stored and data.get("token"):
            stored = hash_token(str(data.get("token") or ""))
        if not stored or len(stored) != len(wanted) or not hmac.compare_digest(stored, wanted):
            continue
        user = db.get(User, path.parent.name)
        if user is None:
            return None
        if not user_is_licensed(db, user):
            return None
        return user
    return None


def _rrule(item: Item) -> dict[str, Any] | None:
    unit = (item.recur_unit or "").strip().lower()
    freq = RRULE_FREQ.get(unit)
    interval = item.recur_interval or 0
    if not freq or interval < 1:
        return None
    return {"FREQ": freq, "INTERVAL": interval}


def build_calendar(db: Session, user: User) -> bytes:
    cal = Calendar()
    cal.add("prodid", "-//TTM-Todo//Calendar Feed//EN")
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    cal.add("method", "PUBLISH")
    cal.add("x-wr-calname", "TTM-Todo")

    rows = list(
        db.scalars(
            select(Item)
            .options(joinedload(Item.bucket))
            .where(Item.user_id == user.id, Item.status == "open", Item.due_at.is_not(None))
            .order_by(Item.due_at.asc())
        ).unique()
    )
    stamp = _utcnow()
    for item in rows:
        start = _utc(item.due_at)
        if start is None:
            continue
        end = start + timedelta(minutes=TASK_MINUTES)
        title = (item.title or "").strip() or "Untitled"
        event = Event()
        event.add("uid", f"{item.id}@ttm-todo")
        event.add("dtstamp", stamp)
        event.add("dtstart", start)
        event.add("dtend", end)
        event.add("summary", title)
        created = _utc(item.created_at)
        if created is not None:
            event.add("created", created)
            event.add("last-modified", created)
        notes = (item.notes or "").strip()
        if notes:
            event.add("description", notes)
        bucket_name = (item.bucket.name if item.bucket is not None else "").strip()
        if bucket_name:
            event.add("categories", bucket_name)
        event.add("transp", "TRANSPARENT")
        rrule = _rrule(item)
        if rrule:
            event.add("rrule", rrule)
        lead = item.reminder_lead_minutes
        if lead and lead > 0:
            alarm = Alarm()
            alarm.add("action", "DISPLAY")
            alarm.add("description", title)
            alarm.add("trigger", timedelta(minutes=-int(lead)))
            event.add_component(alarm)
        cal.add_component(event)
    return cal.to_ical()
