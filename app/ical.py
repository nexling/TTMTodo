from __future__ import annotations

import ipaddress
import json
import logging
import socket
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator
from urllib.parse import urljoin, urlparse

import requests
from dateutil.rrule import rruleset, rrulestr
from icalendar import Calendar

from app.models import User
from app.userfiles import ical_config_path

log = logging.getLogger("magictodo.ical")

PALETTE = ("#6a8caf", "#b57bb0", "#7c9a6d", "#d4654f", "#e8a54b", "#c4842e")
CACHE_TTL = 15 * 60
FETCH_TIMEOUT = 20
MAX_BYTES = 8 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_INSTANCES = 400
MAX_FEEDS = 20

_ical_user: ContextVar[User | None] = ContextVar("ical_user", default=None)
_cache: dict[tuple[str, str], dict[str, Any]] = {}


class IcalError(Exception):
    pass


@contextmanager
def acting_as(user: User) -> Iterator[User]:
    token = _ical_user.set(user)
    try:
        yield user
    finally:
        _ical_user.reset(token)


def _user() -> User:
    user = _ical_user.get()
    if user is None:
        raise IcalError("ICS config has no user context")
    return user


def _empty_feed() -> dict[str, Any]:
    return {
        "id": "",
        "label": "",
        "url": "",
        "color": PALETTE[0],
        "error": "",
        "etag": "",
        "last_fetch": 0,
    }


def _empty_config() -> dict[str, Any]:
    return {"feeds": []}


def _normalize_feed(raw: dict[str, Any]) -> dict[str, Any]:
    feed = _empty_feed()
    feed.update({k: raw[k] for k in feed if k in raw})
    feed["id"] = str(feed.get("id") or "").strip()
    feed["label"] = str(feed.get("label") or "").strip()
    feed["url"] = str(feed.get("url") or "").strip()
    feed["color"] = str(feed.get("color") or PALETTE[0]).strip() or PALETTE[0]
    feed["error"] = str(feed.get("error") or "")
    feed["etag"] = str(feed.get("etag") or "")
    try:
        feed["last_fetch"] = float(feed.get("last_fetch") or 0)
    except (TypeError, ValueError):
        feed["last_fetch"] = 0
    return feed


def load_config() -> dict[str, Any]:
    path = ical_config_path(_user().id)
    if not path.is_file():
        return _empty_config()
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return _empty_config()
    if not isinstance(raw, dict):
        return _empty_config()
    feeds = []
    for row in raw.get("feeds") or []:
        if not isinstance(row, dict):
            continue
        feed = _normalize_feed(row)
        if feed["id"] and feed["url"]:
            feeds.append(feed)
    return {"feeds": feeds}


def save_config(cfg: dict[str, Any]) -> None:
    path = ical_config_path(_user().id)
    path.write_text(json.dumps(cfg, indent=2))
    path.chmod(0o600)


def _feeds() -> list[dict[str, Any]]:
    return list(load_config().get("feeds") or [])


def _find_feed(feed_id: str) -> dict[str, Any] | None:
    wanted = (feed_id or "").strip()
    if not wanted:
        return None
    for feed in _feeds():
        if feed["id"] == wanted:
            return feed
    return None


def _upsert_feed(feed: dict[str, Any]) -> None:
    fid = str(feed.get("id") or "").strip()
    if not fid:
        raise IcalError("ICS feed is missing an id")
    feed["id"] = fid
    cfg = load_config()
    for i, row in enumerate(cfg["feeds"]):
        if row.get("id") == fid:
            cfg["feeds"][i] = feed
            save_config(cfg)
            return
    cfg["feeds"].append(feed)
    save_config(cfg)


def _feed_out(feed: dict[str, Any]) -> dict[str, Any]:
    err = str(feed.get("error") or "") or None
    return {
        "id": feed["id"],
        "label": feed.get("label") or "Calendar",
        "url": feed.get("url") or "",
        "color": feed.get("color") or PALETTE[0],
        "error": err,
        "last_fetch": float(feed.get("last_fetch") or 0),
    }


def status_payload(user: User) -> dict[str, Any]:
    with acting_as(user):
        return {"feeds": [_feed_out(feed) for feed in _feeds()]}


def _blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or (isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped and _blocked_ip(ip.ipv4_mapped))
    )


def validate_ics_url(url: str) -> str:
    text = (url or "").strip()
    parsed = urlparse(text)
    if parsed.scheme != "https":
        raise IcalError("ICS URL must be HTTPS")
    if parsed.username or parsed.password:
        raise IcalError("ICS URL must not include a username or password")
    host = parsed.hostname
    if not host:
        raise IcalError("ICS URL is missing a host")
    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise IcalError("Could not resolve ICS host") from exc
    if not infos:
        raise IcalError("Could not resolve ICS host")
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if _blocked_ip(ip):
            raise IcalError("ICS URL host is not allowed")
    return text


def _color(value: str) -> str:
    text = (value or "").strip()
    if text.lower() in {c.lower() for c in PALETTE}:
        for c in PALETTE:
            if c.lower() == text.lower():
                return c
    if len(text) == 7 and text.startswith("#") and all(ch in "0123456789abcdefABCDEF" for ch in text[1:]):
        return text.lower()
    return PALETTE[0]


def add_feed(user: User, *, label: str, url: str, color: str) -> dict[str, Any]:
    with acting_as(user):
        if len(_feeds()) >= MAX_FEEDS:
            raise IcalError("Too many calendar subscriptions")
        safe_url = validate_ics_url(url)
        feed = _empty_feed()
        feed["id"] = uuid.uuid4().hex
        feed["label"] = (label or "").strip() or "Calendar"
        feed["url"] = safe_url
        feed["color"] = _color(color)
        _upsert_feed(feed)
        try:
            _refresh_feed(feed, force=True)
        except IcalError as exc:
            feed["error"] = str(exc)
            _upsert_feed(feed)
        return status_payload(user)


def patch_feed(user: User, feed_id: str, body: dict[str, Any]) -> dict[str, Any]:
    with acting_as(user):
        feed = _find_feed(feed_id)
        if feed is None:
            raise IcalError("Calendar subscription not found")
        if "label" in body and body["label"] is not None:
            feed["label"] = str(body["label"] or "").strip() or feed["label"] or "Calendar"
        if "color" in body and body["color"] is not None:
            feed["color"] = _color(str(body["color"] or ""))
        if "url" in body and body["url"] is not None:
            safe_url = validate_ics_url(str(body["url"]))
            if safe_url != feed.get("url"):
                feed["url"] = safe_url
                feed["etag"] = ""
                feed["last_fetch"] = 0
                _cache.pop((_user().id, feed["id"]), None)
                try:
                    _refresh_feed(feed, force=True)
                except IcalError as exc:
                    feed["error"] = str(exc)
        _upsert_feed(feed)
        return status_payload(user)


def delete_feed(user: User, feed_id: str) -> dict[str, Any]:
    with acting_as(user):
        cfg = load_config()
        cfg["feeds"] = [row for row in cfg["feeds"] if row.get("id") != feed_id]
        save_config(cfg)
        _cache.pop((user.id, feed_id), None)
        return status_payload(user)


def _fetch_https(url: str, etag: str) -> tuple[int, bytes, str]:
    current = validate_ics_url(url)
    headers = {
        "User-Agent": "TTM-Todo-calendar/1.0",
        "Accept": "text/calendar, text/plain, */*",
    }
    if etag:
        headers["If-None-Match"] = etag
    for _ in range(MAX_REDIRECTS + 1):
        try:
            response = requests.get(
                current,
                headers=headers,
                timeout=FETCH_TIMEOUT,
                allow_redirects=False,
                stream=True,
            )
        except requests.RequestException as exc:
            raise IcalError("Could not download calendar") from exc
        if response.status_code in {301, 302, 303, 307, 308}:
            location = response.headers.get("Location") or ""
            response.close()
            if not location:
                raise IcalError("Calendar redirect was empty")
            current = validate_ics_url(urljoin(current, location))
            continue
        if response.status_code == 304:
            response.close()
            return 304, b"", etag
        if response.status_code >= 400:
            response.close()
            raise IcalError("Calendar feed returned an error")
        chunks: list[bytes] = []
        total = 0
        try:
            for chunk in response.iter_content(64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_BYTES:
                    raise IcalError("Calendar feed is too large")
                chunks.append(chunk)
        finally:
            response.close()
        next_etag = str(response.headers.get("ETag") or "")
        return response.status_code, b"".join(chunks), next_etag
    raise IcalError("Too many calendar redirects")


def _refresh_feed(feed: dict[str, Any], *, force: bool = False) -> bytes | None:
    user_id = _user().id
    key = (user_id, feed["id"])
    cached = _cache.get(key)
    now = time.time()
    if (
        not force
        and cached
        and cached.get("body")
        and now - float(cached.get("fetched_at") or 0) < CACHE_TTL
    ):
        return cached["body"]
    etag = str((cached or {}).get("etag") or feed.get("etag") or "")
    try:
        status, body, next_etag = _fetch_https(str(feed.get("url") or ""), etag if cached else "")
    except IcalError:
        raise
    except Exception as exc:
        raise IcalError("Could not download calendar") from exc
    if status == 304 and cached and cached.get("body"):
        body = cached["body"]
        next_etag = etag or next_etag
    elif not body:
        raise IcalError("Calendar feed was empty")
    _cache[key] = {"body": body, "etag": next_etag, "fetched_at": now}
    feed["etag"] = next_etag
    feed["last_fetch"] = now
    feed["error"] = ""
    _upsert_feed(feed)
    return body


def _as_utc(value: datetime | date) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)


def _is_date(value: Any) -> bool:
    return isinstance(value, date) and not isinstance(value, datetime)


def _prop_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _collect_stamps(component: Any, name: str) -> list[datetime]:
    out: list[datetime] = []
    value = component.get(name)
    if not value:
        return out
    for item in _prop_list(value):
        dts = getattr(item, "dts", None)
        if dts:
            for stamp in dts:
                dt = getattr(stamp, "dt", None)
                if isinstance(dt, (datetime, date)):
                    out.append(_as_utc(dt))
            continue
        dt = getattr(item, "dt", None)
        if isinstance(dt, (datetime, date)):
            out.append(_as_utc(dt))
    return out


def _expand_starts(component: Any, start: datetime, window_start: datetime, window_end: datetime) -> list[datetime]:
    rs = rruleset()
    rrule = component.get("RRULE")
    if rrule:
        try:
            line = "RRULE:" + rrule.to_ical().decode("utf-8")
            rs.rrule(rrulestr(line, dtstart=start))
        except Exception:
            rs.rdate(start)
    else:
        rs.rdate(start)
    for dt in _collect_stamps(component, "RDATE"):
        rs.rdate(dt)
    for dt in _collect_stamps(component, "EXDATE"):
        rs.exdate(dt)
    pad = window_start - timedelta(days=2)
    try:
        instances = rs.between(pad, window_end, inc=True)
    except Exception:
        if window_start <= start < window_end:
            return [start]
        return []
    out: list[datetime] = []
    for inst in instances:
        out.append(_as_utc(inst) if isinstance(inst, datetime) else _as_utc(inst))
        if len(out) >= MAX_INSTANCES:
            break
    return out


def _text(component: Any, name: str) -> str:
    value = component.get(name)
    if value is None:
        return ""
    try:
        decoded = component.decoded(name)
    except Exception:
        decoded = value
    if isinstance(decoded, bytes):
        return decoded.decode("utf-8", "replace").strip()
    return str(decoded or "").strip()


def _duration(component: Any, start: datetime, all_day: bool) -> timedelta:
    if "DTEND" in component:
        end_raw = component.decoded("DTEND")
        end = _as_utc(end_raw)
        if _is_date(end_raw) or all_day:
            end = datetime(end_raw.year, end_raw.month, end_raw.day, tzinfo=timezone.utc)
        delta = end - start
        if delta.total_seconds() <= 0:
            return timedelta(days=1) if all_day else timedelta(minutes=30)
        return delta
    if "DURATION" in component:
        try:
            dur = component.decoded("DURATION")
            if isinstance(dur, timedelta) and dur.total_seconds() > 0:
                return dur
        except Exception:
            pass
    return timedelta(days=1) if all_day else timedelta(hours=1)


def _events_from_body(
    feed: dict[str, Any],
    body: bytes,
    window_start: datetime,
    window_end: datetime,
) -> list[dict[str, Any]]:
    try:
        calendar = Calendar.from_ical(body)
    except Exception as exc:
        raise IcalError("Could not parse calendar") from exc
    label = str(feed.get("label") or "Calendar")
    color = str(feed.get("color") or PALETTE[0])
    feed_id = str(feed.get("id") or "")
    out: list[dict[str, Any]] = []
    for component in calendar.walk("VEVENT"):
        if component.get("STATUS") and str(component.get("STATUS")).upper() == "CANCELLED":
            continue
        try:
            raw_start = component.decoded("DTSTART")
        except Exception:
            continue
        all_day = _is_date(raw_start)
        start = _as_utc(raw_start)
        duration = _duration(component, start, all_day)
        uid = _text(component, "UID") or f"{_text(component, 'SUMMARY')}-{start.isoformat()}"
        subject = _text(component, "SUMMARY") or "(no title)"
        location = _text(component, "LOCATION")
        web_link = _text(component, "URL") or None
        for inst in _expand_starts(component, start, window_start, window_end):
            inst_end = inst + duration
            if inst_end <= window_start or inst >= window_end:
                continue
            stamp = inst.strftime("%Y%m%dT%H%M%S")
            out.append(
                {
                    "id": f"{feed_id}:{uid}:{stamp}",
                    "calendar_id": feed_id,
                    "calendar_name": label,
                    "color": color,
                    "subject": subject,
                    "start": inst,
                    "end": inst_end,
                    "is_all_day": all_day,
                    "location": location,
                    "web_link": web_link,
                }
            )
            if len(out) >= MAX_INSTANCES * 3:
                return out
    return out


def fetch_events(user: User, start: datetime, end: datetime) -> list[dict[str, Any]]:
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    else:
        start = start.astimezone(timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    else:
        end = end.astimezone(timezone.utc)
    out: list[dict[str, Any]] = []
    with acting_as(user):
        for feed in _feeds():
            try:
                body = _refresh_feed(feed)
                if not body:
                    continue
                out.extend(_events_from_body(feed, body, start, end))
            except IcalError as exc:
                feed["error"] = str(exc)
                if feed.get("id"):
                    _upsert_feed(feed)
                log.warning("ICS feed %s failed", feed.get("id"))
            except Exception as exc:
                feed["error"] = "Could not read calendar"
                if feed.get("id"):
                    _upsert_feed(feed)
                log.warning("ICS feed %s failed: %s", feed.get("id"), exc)
    return out
