import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.auth0 import configure_oauth, login_router as auth0_login_router, logout_router as auth0_logout_router
from app.bootstrap import bootstrap
from app.session import SchemeAwareSessionMiddleware
from app.config import settings
from app.database import get_db
from app.deps import get_session_user
from app.models import Bucket, Item, User
from app.orgs import user_is_licensed
from app.live import router as live_router, set_loop
from app.routers import admin, auth, buckets, calendar_export, files, google, ical, inbox, items, notifications, orgs, outlook, plan, remarkable, push, tokens
from app.routers.items import add_attachment

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("magictodo")

DIST_DIR = Path(__file__).resolve().parent.parent / "web" / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if settings.secret_key in {"", "dev-only-change-me", "change-me-to-a-long-random-string"}:
        log.warning("SECRET_KEY is not set to a strong value")
    bootstrap()
    configure_oauth()
    set_loop(asyncio.get_running_loop())
    try:
        yield
    finally:
        set_loop(None)


app = FastAPI(title="TTM-Todo", docs_url=None, redoc_url=None, lifespan=lifespan)
app.add_middleware(
    SchemeAwareSessionMiddleware,
    secret_key=settings.secret_key,
    session_cookie="magictodo_session",
    same_site="lax",
    https_only=settings.session_https_only,
    max_age=60 * 60 * 24 * 30,
)
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="127.0.0.1")

app.include_router(auth0_logout_router)
if settings.auth0_is_enabled:
    app.include_router(auth0_login_router)
app.include_router(auth.router)
app.include_router(orgs.router)
app.include_router(plan.router)
app.include_router(admin.router)
app.include_router(buckets.router)
app.include_router(items.router)
app.include_router(inbox.router)
app.include_router(tokens.router)
app.include_router(files.router)
app.include_router(remarkable.router)
app.include_router(google.router)
app.include_router(outlook.router)
app.include_router(ical.router)
app.include_router(calendar_export.router)
app.include_router(push.router)
app.include_router(notifications.router)
app.include_router(live_router)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/share-target")
async def share_target(
    request: Request,
    title: str | None = Form(default=None),
    text: str | None = Form(default=None),
    url: str | None = Form(default=None),
    image: UploadFile | None = File(default=None),
    user: User | None = Depends(get_session_user),
    db: Session = Depends(get_db),
):
    """Android PWA Share Target — session cookie, then redirect home."""
    if user is None:
        return RedirectResponse("/login", status_code=303)
    if not user_is_licensed(db, user, request.session.get("active_organization_id")):
        return RedirectResponse("/unlicensed", status_code=303)

    parts = [p.strip() for p in (title, text, url) if p and p.strip()]
    combined = "\n".join(parts).strip()
    has_image = image is not None and image.filename
    if not combined and not has_image:
        return RedirectResponse("/", status_code=303)

    inbox = db.scalar(
        select(Bucket).where(Bucket.user_id == user.id, Bucket.is_inbox.is_(True))
    )
    if inbox is None:
        raise HTTPException(status_code=500, detail="Inbox missing")

    item_title = None
    notes = None
    if combined:
        if "\n" in combined:
            first, rest = combined.split("\n", 1)
            item_title = first.strip()[:500] or None
            notes = rest.strip() or None
        else:
            item_title = combined[:500]

    item = Item(
        user_id=user.id,
        bucket_id=inbox.id,
        title=item_title,
        notes=notes,
        source="share",
        status="open",
    )
    db.add(item)
    db.flush()
    if has_image:
        add_attachment(db, item, image)
    db.commit()
    return RedirectResponse("/", status_code=303)


@app.get("/{full_path:path}")
def spa(full_path: str):
    if not DIST_DIR.is_dir():
        return {
            "detail": "Frontend not built. Run: cd web && npm install && npm run build",
            "api": "/api/health",
        }
    dist = DIST_DIR.resolve()
    if full_path:
        candidate = (DIST_DIR / full_path).resolve()
        try:
            candidate.relative_to(dist)
        except ValueError:
            raise HTTPException(status_code=404, detail="Not found") from None
        if candidate.is_file():
            return FileResponse(candidate)
    index = DIST_DIR / "index.html"
    if index.is_file():
        return FileResponse(index)
    return {"detail": "Frontend not built. Run: cd web && npm install && npm run build"}
