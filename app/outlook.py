from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Iterator
from urllib.parse import quote, urlparse

import requests

from app.config import settings
from app.models import User
from app.security import HEX_COLOR
from app.userfiles import outlook_config_path

log = logging.getLogger("magictodo.outlook")

GRAPH = "https://graph.microsoft.com/v1.0"
SCOPES = ["Calendars.Read", "User.Read"]
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
PALETTE = ("#6a8caf", "#b57bb0", "#7c9a6d", "#d4654f", "#e8a54b", "#c4842e")
INSECURE_OAUTH_REDIRECT = (
    "Microsoft blocks HTTP OAuth except on 127.0.0.1. From Windows run "
    "ssh -L 8010:127.0.0.1:8010 nexserve, open http://127.0.0.1:8010/settings, "
    "then Connect Outlook. Register http://127.0.0.1:8010/api/outlook/callback "
    "on the Azure app — not the Tailscale http URL."
)


class OutlookError(Exception):
    pass


_outlook_user: ContextVar[User | None] = ContextVar("outlook_user", default=None)


@contextmanager
def acting_as(user: User) -> Iterator[User]:
    token = _outlook_user.set(user)
    try:
        yield user
    finally:
        _outlook_user.reset(token)


def _user() -> User:
    user = _outlook_user.get()
    if user is None:
        raise OutlookError("Outlook config has no user context")
    return user


def _empty_account() -> dict[str, Any]:
    return {
        "id": "",
        "label": "",
        "access_token": "",
        "refresh_token": "",
        "expiry": 0,
        "calendar_ids": [],
        "calendar_colors": {},
        "cached_calendars": [],
        "error": "",
    }


def _empty_config() -> dict[str, Any]:
    return {"accounts": []}


def _normalize_calendar_colors(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in raw.items():
        cid = str(key or "").strip()
        color = str(value or "").strip()
        if cid and HEX_COLOR.match(color):
            out[cid] = color.lower()
    return out


def _normalize_account(raw: dict[str, Any]) -> dict[str, Any]:
    acc = _empty_account()
    acc.update({k: raw[k] for k in acc if k in raw})
    if not acc["id"]:
        acc["id"] = str(acc.get("label") or "").strip()
    acc["calendar_colors"] = _normalize_calendar_colors(acc.get("calendar_colors"))
    acc["calendar_ids"] = [str(cid) for cid in (acc.get("calendar_ids") or []) if cid]
    return acc


def _migrate(raw: dict[str, Any]) -> dict[str, Any]:
    if isinstance(raw.get("accounts"), list):
        accounts = []
        for row in raw["accounts"]:
            if not isinstance(row, dict):
                continue
            acc = _normalize_account(row)
            if acc.get("id") or acc.get("refresh_token") or acc.get("access_token"):
                accounts.append(acc)
        return {"accounts": accounts}
    if raw.get("refresh_token") or raw.get("access_token"):
        acc = _normalize_account(raw)
        if not acc["id"]:
            acc["id"] = str(raw.get("label") or "account").strip() or "account"
            acc["label"] = acc["label"] or acc["id"]
        return {"accounts": [acc]}
    return _empty_config()


def load_config() -> dict[str, Any]:
    path = outlook_config_path(_user().id)
    if not path.is_file():
        return _empty_config()
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return _empty_config()
    if not isinstance(raw, dict):
        return _empty_config()
    return _migrate(raw)


def save_config(cfg: dict[str, Any]) -> None:
    path = outlook_config_path(_user().id)
    path.write_text(json.dumps(cfg, indent=2))
    path.chmod(0o600)


def oauth_configured() -> bool:
    return bool(settings.microsoft_client_id.strip() and settings.microsoft_client_secret.strip())


def connected() -> bool:
    return any(
        acc.get("refresh_token") or acc.get("access_token") for acc in load_config().get("accounts") or []
    )


def _accounts() -> list[dict[str, Any]]:
    return list(load_config().get("accounts") or [])


def _find_account(account_id: str) -> dict[str, Any] | None:
    wanted = (account_id or "").strip().casefold()
    if not wanted:
        return None
    for acc in _accounts():
        if str(acc.get("id") or "").strip().casefold() == wanted:
            return acc
    return None


def _upsert_account(account: dict[str, Any]) -> None:
    aid = str(account.get("id") or "").strip()
    if not aid:
        raise OutlookError("Outlook account is missing an id")
    account["id"] = aid
    cfg = load_config()
    found = False
    for i, row in enumerate(cfg["accounts"]):
        if str(row.get("id") or "").strip().casefold() == aid.casefold():
            cfg["accounts"][i] = account
            found = True
            break
    if not found:
        cfg["accounts"].append(account)
    save_config(cfg)


def redirect_uri(request_base: str | None = None) -> str:
    explicit = settings.microsoft_redirect_uri.strip()
    if explicit:
        return explicit.rstrip("/")
    if request_base:
        return request_base.rstrip("/") + "/api/outlook/callback"
    return f"http://127.0.0.1:{settings.port}/api/outlook/callback"


def oauth_redirect_allowed(uri: str) -> bool:
    parsed = urlparse(uri)
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and host:
        return True
    return parsed.scheme == "http" and host in LOOPBACK_HOSTS


def _authority() -> str:
    tenant = (settings.microsoft_tenant or "common").strip() or "common"
    return f"https://login.microsoftonline.com/{tenant}"


def _msal_app():
    import msal

    if not oauth_configured():
        raise OutlookError("MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are not set")
    return msal.ConfidentialClientApplication(
        settings.microsoft_client_id.strip(),
        authority=_authority(),
        client_credential=settings.microsoft_client_secret.strip(),
    )


def authorization_flow(redir: str) -> dict[str, Any]:
    app = _msal_app()
    return app.initiate_auth_code_flow(SCOPES, redirect_uri=redir, prompt="select_account")


def _apply_tokens(account: dict[str, Any], result: dict[str, Any]) -> None:
    account["access_token"] = result.get("access_token") or ""
    refresh = result.get("refresh_token") or account.get("refresh_token") or ""
    account["refresh_token"] = refresh
    expires_in = int(result.get("expires_in") or 0)
    account["expiry"] = datetime.now(timezone.utc).timestamp() + expires_in - 60 if expires_in else 0
    claims = result.get("id_token_claims") or {}
    if isinstance(claims, dict):
        hint = str(claims.get("preferred_username") or claims.get("email") or "").strip()
        if hint:
            if not account.get("label"):
                account["label"] = hint
            if not account.get("id"):
                account["id"] = hint


def exchange_code(flow: dict[str, Any], query: dict[str, str], user: User) -> None:
    with acting_as(user):
        app = _msal_app()
        result = app.acquire_token_by_auth_code_flow(flow, query)
        if "access_token" not in result:
            raise OutlookError(result.get("error_description") or result.get("error") or "Outlook sign-in failed")
        account = _empty_account()
        _apply_tokens(account, result)
        try:
            label = _fetch_label(account)
            if label:
                account["id"] = label
                account["label"] = label
            if not account.get("id"):
                raise OutlookError("Outlook did not return an account email")
            existing = _find_account(account["id"])
            is_new = existing is None
            if existing:
                account["calendar_ids"] = list(existing.get("calendar_ids") or [])
                account["cached_calendars"] = list(existing.get("cached_calendars") or [])
                account["calendar_colors"] = dict(existing.get("calendar_colors") or {})
            calendars = fetch_calendars(account)
            _apply_calendars(account, calendars, auto_pick=is_new)
            account["error"] = ""
            _upsert_account(account)
        except OutlookError:
            raise
        except Exception as exc:
            log.warning("Could not list Outlook calendars after OAuth: %s", exc)
            account["error"] = str(exc)
            if account.get("id"):
                _upsert_account(account)
            raise OutlookError(str(exc)) from exc


def disconnect(user: User, account_id: str | None = None) -> None:
    with acting_as(user):
        wanted = (account_id or "").strip()
        if not wanted:
            save_config(_empty_config())
            return
        cfg = load_config()
        cfg["accounts"] = [
            row for row in cfg["accounts"] if str(row.get("id") or "").strip().casefold() != wanted.casefold()
        ]
        save_config(cfg)


def _access_token(account: dict[str, Any]) -> str:
    token = str(account.get("access_token") or "")
    try:
        expiry_ts = float(account.get("expiry") or 0)
    except (TypeError, ValueError):
        expiry_ts = 0
    if token and expiry_ts and expiry_ts > datetime.now(timezone.utc).timestamp():
        return token
    refresh = str(account.get("refresh_token") or "")
    if not refresh:
        raise OutlookError("Outlook is not connected")
    app = _msal_app()
    result = app.acquire_token_by_refresh_token(refresh, SCOPES)
    if "access_token" not in result:
        raise OutlookError(result.get("error_description") or result.get("error") or "Outlook token refresh failed")
    _apply_tokens(account, result)
    if account.get("id"):
        _upsert_account(account)
    return str(result["access_token"])


def _graph(account: dict[str, Any], method: str, url: str, *, params: dict[str, str] | None = None) -> dict[str, Any]:
    token = _access_token(account)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Prefer": 'outlook.timezone="UTC"',
    }
    res = requests.request(method, url, headers=headers, params=params, timeout=30)
    if res.status_code >= 400:
        detail = res.text[:400]
        raise OutlookError(f"Microsoft Graph {res.status_code}: {detail}")
    if not res.content:
        return {}
    data = res.json()
    return data if isinstance(data, dict) else {}


def _fetch_label(account: dict[str, Any]) -> str:
    me = _graph(account, "GET", f"{GRAPH}/me", params={"$select": "userPrincipalName,mail,displayName"})
    return str(me.get("userPrincipalName") or me.get("mail") or me.get("displayName") or "").strip()


def _calendar_color(row: dict[str, Any], index: int) -> str:
    hex_color = str(row.get("hexColor") or "").strip()
    if HEX_COLOR.match(hex_color):
        return hex_color.lower()
    return PALETTE[index % len(PALETTE)]


def _display_color(account: dict[str, Any], calendar_id: str, fallback: str) -> str:
    stored = (account.get("calendar_colors") or {}).get(calendar_id)
    if isinstance(stored, str) and HEX_COLOR.match(stored.strip()):
        return stored.strip().lower()
    return fallback or PALETTE[0]


def fetch_calendars(account: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    url = f"{GRAPH}/me/calendars"
    params = {"$select": "id,name,hexColor,isDefaultCalendar,color", "$top": "50"}
    while url:
        data = _graph(account, "GET", url, params=params)
        params = None
        for i, row in enumerate(data.get("value") or []):
            cid = str(row.get("id") or "")
            if not cid:
                continue
            rows.append(
                {
                    "id": cid,
                    "name": str(row.get("name") or "").strip() or "Calendar",
                    "color": _calendar_color(row, i),
                    "is_default": bool(row.get("isDefaultCalendar")),
                }
            )
        url = str(data.get("@odata.nextLink") or "")
    return rows


def _apply_calendars(account: dict[str, Any], calendars: list[dict[str, Any]], *, auto_pick: bool) -> None:
    account["cached_calendars"] = calendars
    stored = [cid for cid in (account.get("calendar_ids") or []) if cid]
    known = {row["id"] for row in calendars}
    stored = [cid for cid in stored if cid in known]
    if auto_pick and not stored:
        stored = [row["id"] for row in calendars if row.get("is_default")]
        if not stored and calendars:
            stored = [calendars[0]["id"]]
    account["calendar_ids"] = stored


def set_calendars(
    user: User,
    account_id: str,
    calendar_ids: list[str],
    calendar_colors: dict[str, str] | None = None,
) -> None:
    wanted = [cid.strip() for cid in calendar_ids if cid and cid.strip()]
    with acting_as(user):
        account = _find_account(account_id)
        if account is None:
            raise OutlookError("That Outlook account is not connected")
        calendars = fetch_calendars(account)
        known = {row["id"] for row in calendars}
        missing = [cid for cid in wanted if cid not in known]
        if missing:
            raise OutlookError("One or more Outlook calendars were not found")
        account["calendar_ids"] = wanted
        account["cached_calendars"] = calendars
        if calendar_colors is not None:
            colors = dict(account.get("calendar_colors") or {})
            for cid, color in calendar_colors.items():
                key = str(cid or "").strip()
                if key not in known:
                    continue
                text = str(color or "").strip()
                if not HEX_COLOR.match(text):
                    raise OutlookError("Color must be a hex value like #e8a54b")
                colors[key] = text.lower()
            account["calendar_colors"] = {cid: color for cid, color in colors.items() if cid in known}
        account["error"] = ""
        _upsert_account(account)


def _parse_graph_dt(value: Any) -> datetime | None:
    if not isinstance(value, dict):
        return None
    raw = str(value.get("dateTime") or "").strip()
    if not raw:
        return None
    raw = raw.replace(" ", "T")
    if raw.endswith("Z"):
        text = raw
    else:
        text = raw.split(".")[0]
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
        tzname = str(value.get("timeZone") or "UTC")
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc if tzname.upper() in {"UTC", "UTC STANDARD TIME"} else timezone.utc)
        return dt.astimezone(timezone.utc)
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _events_for_account(account: dict[str, Any], start_s: str, end_s: str) -> list[dict[str, Any]]:
    calendars = list(account.get("cached_calendars") or [])
    selected = {cid for cid in (account.get("calendar_ids") or []) if cid}
    if not selected:
        selected = {row["id"] for row in calendars if row.get("is_default")} or {row["id"] for row in calendars[:1]}
    by_id = {row["id"]: row for row in calendars}
    label = str(account.get("label") or account.get("id") or "").strip()
    out: list[dict[str, Any]] = []
    for cid in selected:
        meta = by_id.get(cid) or {"id": cid, "name": "Calendar", "color": PALETTE[0]}
        cal_name = str(meta.get("name") or "Calendar")
        display = f"{label} · {cal_name}" if label else cal_name
        event_color = _display_color(account, cid, str(meta.get("color") or PALETTE[0]))
        url = f"{GRAPH}/me/calendars/{quote(cid, safe='')}/calendarView"
        params = {
            "startDateTime": start_s,
            "endDateTime": end_s,
            "$select": "id,subject,start,end,isAllDay,location,webLink",
            "$orderby": "start/dateTime",
            "$top": "100",
        }
        while url:
            data = _graph(account, "GET", url, params=params)
            params = None
            for row in data.get("value") or []:
                start_dt = _parse_graph_dt(row.get("start"))
                end_dt = _parse_graph_dt(row.get("end"))
                if start_dt is None:
                    continue
                if end_dt is None:
                    end_dt = start_dt
                loc = row.get("location") or {}
                location = ""
                if isinstance(loc, dict):
                    location = str(loc.get("displayName") or "").strip()
                event_id = str(row.get("id") or "")
                out.append(
                    {
                        "id": f"{account.get('id')}:{event_id}" if account.get("id") else event_id,
                        "calendar_id": cid,
                        "calendar_name": display,
                        "color": event_color,
                        "subject": str(row.get("subject") or "").strip(),
                        "start": start_dt,
                        "end": end_dt,
                        "is_all_day": bool(row.get("isAllDay")),
                        "location": location,
                        "web_link": str(row.get("webLink") or "") or None,
                    }
                )
            url = str(data.get("@odata.nextLink") or "")
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
    with acting_as(user):
        start_s = start.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        end_s = end.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        out: list[dict[str, Any]] = []
        for account in _accounts():
            if not (account.get("refresh_token") or account.get("access_token")):
                continue
            try:
                out.extend(_events_for_account(account, start_s, end_s))
                if account.get("error"):
                    account["error"] = ""
                    _upsert_account(account)
            except Exception as exc:
                log.warning("Outlook events failed for %s: %s", account.get("id"), exc)
                account["error"] = str(exc)
                if account.get("id"):
                    _upsert_account(account)
        return out


def _account_status(account: dict[str, Any]) -> dict[str, Any]:
    selected = {cid for cid in (account.get("calendar_ids") or []) if cid}
    err = str(account.get("error") or "") or None
    return {
        "id": str(account.get("id") or ""),
        "label": str(account.get("label") or account.get("id") or ""),
        "error": err,
        "calendars": [
            {
                "id": row["id"],
                "name": row["name"],
                "color": _display_color(account, row["id"], str(row.get("color") or "")),
                "selected": row["id"] in selected,
            }
            for row in (account.get("cached_calendars") or [])
        ],
    }


def status_payload(user: User, *, refresh: bool = False) -> dict[str, Any]:
    with acting_as(user):
        accounts_out = []
        for account in _accounts():
            if refresh:
                try:
                    calendars = fetch_calendars(account)
                    _apply_calendars(account, calendars, auto_pick=not bool(account.get("calendar_ids")))
                    account["error"] = ""
                    _upsert_account(account)
                except Exception as exc:
                    account["error"] = str(exc)
                    if account.get("id"):
                        _upsert_account(account)
                    log.warning("Outlook calendar refresh failed for %s: %s", account.get("id"), exc)
            accounts_out.append(_account_status(account))
        return {
            "configured": oauth_configured(),
            "connected": bool(accounts_out),
            "accounts": accounts_out,
        }
