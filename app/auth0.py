from __future__ import annotations

import logging
from urllib.parse import quote_plus, urlencode, urlparse

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.orgs import upsert_authenticated_user

log = logging.getLogger("magictodo")

SESSION_USER_KEY = "user_id"
SESSION_ORG_KEY = "active_organization_id"
POST_LOGIN_REDIRECT_KEY = "auth_post_login_redirect"

oauth = OAuth()
logout_router = APIRouter(tags=["auth0"])
login_router = APIRouter(tags=["auth0"])
router = login_router
_registered = False


def configure_oauth() -> None:
    global _registered
    if _registered or not settings.auth0_is_enabled:
        return
    missing = [
        name
        for name, value in (
            ("AUTH0_DOMAIN", settings.auth0_domain),
            ("AUTH0_CLIENT_ID", settings.auth0_client_id),
            ("AUTH0_CLIENT_SECRET", settings.auth0_client_secret),
        )
        if not value.strip()
    ]
    if missing:
        raise RuntimeError("Auth0 is enabled, but missing: " + ", ".join(missing))
    oauth.register(
        "auth0",
        client_id=settings.auth0_client_id.strip(),
        client_secret=settings.auth0_client_secret.strip(),
        client_kwargs={"scope": settings.auth0_scope.strip() or "openid profile email"},
        server_metadata_url=f"https://{settings.auth0_domain.strip()}/.well-known/openid-configuration",
    )
    _registered = True


def sanitize_next_path(candidate: str | None, fallback: str = "/") -> str:
    if not candidate:
        return fallback
    parsed = urlparse(candidate)
    if parsed.scheme or parsed.netloc:
        return fallback
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = "/" + path.lstrip("/")
    if path.startswith("//"):
        return fallback
    query = f"?{parsed.query}" if parsed.query else ""
    fragment = f"#{parsed.fragment}" if parsed.fragment else ""
    return f"{path}{query}{fragment}"


def public_origin() -> str:
    return settings.public_url.strip().rstrip("/")


def auth0_origin(request: Request) -> str:
    """HTTPS public URL when Host matches PUBLIC_URL; otherwise this request's origin."""
    incoming = str(request.base_url).rstrip("/")
    public = public_origin()
    if not public:
        return incoming
    host = (request.headers.get("host") or urlparse(incoming).netloc or "").split(":")[0].lower()
    public_host = (urlparse(public).hostname or "").lower()
    if public_host and host == public_host:
        return public
    return incoming


def callback_uri(request: Request) -> str:
    return auth0_origin(request) + "/callback"


def store_session(request: Request, context: dict | None) -> None:
    if not context or not context.get("user"):
        request.session.pop(SESSION_USER_KEY, None)
        request.session.pop(SESSION_ORG_KEY, None)
        return
    request.session[SESSION_USER_KEY] = context["user"]["id"]
    org = context.get("organization") or {}
    if org.get("id"):
        request.session[SESSION_ORG_KEY] = org["id"]
    else:
        request.session.pop(SESSION_ORG_KEY, None)


def auth0_logout_url(request: Request) -> str:
    return_to = auth0_origin(request) + "/"
    params = urlencode(
        {"returnTo": return_to, "client_id": settings.auth0_client_id.strip()},
        quote_via=quote_plus,
    )
    return f"https://{settings.auth0_domain.strip()}/v2/logout?{params}"


@login_router.get("/login")
async def login(request: Request, next: str | None = None, signup: str | None = None):
    if not settings.auth0_is_enabled:
        return RedirectResponse("/", status_code=303)
    configure_oauth()
    if next:
        request.session[POST_LOGIN_REDIRECT_KEY] = sanitize_next_path(next)
    extra: dict[str, str] = {}
    audience = settings.auth0_audience.strip()
    if audience:
        extra["audience"] = audience
    hint = (signup or "").strip().lower()
    if hint and hint not in {"0", "false", "no"}:
        extra["screen_hint"] = "signup"
    return await oauth.auth0.authorize_redirect(request, callback_uri(request), **extra)


@login_router.get("/callback")
async def callback(request: Request, db: Session = Depends(get_db)):
    if not settings.auth0_is_enabled:
        return RedirectResponse("/", status_code=303)
    configure_oauth()
    fail_base = "/?error="
    try:
        token = await oauth.auth0.authorize_access_token(request)
    except Exception:
        log.exception("Auth0 token exchange failed (redirect_uri=%s)", callback_uri(request))
        return RedirectResponse(fail_base + "auth0", status_code=303)
    userinfo = token.get("userinfo") or {}
    if not userinfo.get("sub"):
        try:
            userinfo = await oauth.auth0.userinfo(token=token)
        except Exception:
            log.exception("Auth0 userinfo failed")
            userinfo = {}
    sub = userinfo.get("sub")
    email = userinfo.get("email")
    name = userinfo.get("name") or userinfo.get("nickname") or email
    if not sub:
        log.error("Auth0 callback had no sub in userinfo")
        return RedirectResponse(fail_base + "auth0", status_code=303)
    try:
        context = upsert_authenticated_user(
            db,
            auth_provider_id=sub,
            email=email,
            name=name,
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        return RedirectResponse(fail_base + quote_plus(str(exc)), status_code=303)
    except Exception:
        db.rollback()
        log.exception("Auth0 upsert failed for %s", email)
        raise
    store_session(request, context)
    target = sanitize_next_path(request.session.pop(POST_LOGIN_REDIRECT_KEY, None), fallback="/")
    return RedirectResponse(target, status_code=303)


@logout_router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    if settings.auth0_is_enabled:
        return RedirectResponse(auth0_logout_url(request), status_code=303)
    return RedirectResponse("/", status_code=303)
