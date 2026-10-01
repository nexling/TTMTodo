import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.auth0 import configure_oauth, login_router as auth0_login_router, logout_router as auth0_logout_router
from app.bootstrap import bootstrap
from app.session import SchemeAwareSessionMiddleware
from app.config import settings
from app.database import get_db
from app.deps import get_session_user, require_docs_user
from app.items import create_item
from app.models import User
from app.orgs import user_is_licensed
from app.live import router as live_router, set_loop
from app.routers import admin, auth, buckets, calendar_export, files, google, ical, inbox, items, notifications, orgs, outlook, plan, remarkable, push, tokens

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


app = FastAPI(title="TTM-Todo", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
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


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title="TTM-Todo",
        version="1.0.0",
        description=(
            "Items live in personal buckets. Org/project folders are plan mirrors. "
            "Bearer tokens (`mt_…`) use scopes `inbox`, `items`, `buckets`, and `plan`. "
            "Plan calls send `X-Organization-Id` when the user belongs to more than one licensed org. "
            "Existing capture tokens are inbox-only."
        ),
        routes=app.routes,
    )
    schemes = schema.setdefault("components", {}).setdefault("securitySchemes", {})
    schemes["HTTPBearer"] = {
        "type": "http",
        "scheme": "bearer",
        "description": "API token from Settings (`mt_…`). Scopes: inbox, items, buckets, plan.",
    }
    schema["security"] = [{"HTTPBearer": []}]
    org_header = {
        "name": "X-Organization-Id",
        "in": "header",
        "required": False,
        "schema": {"type": "string"},
        "description": "Required for plan calls when the user has more than one licensed organization.",
    }
    for path, ops in schema.get("paths", {}).items():
        if not path.startswith("/api/plan"):
            continue
        if not isinstance(ops, dict):
            continue
        for op in ops.values():
            if not isinstance(op, dict):
                continue
            params = op.setdefault("parameters", [])
            if any(isinstance(p, dict) and p.get("name") == "X-Organization-Id" for p in params):
                continue
            params.append(org_header)
    app.openapi_schema = schema
    return schema


app.openapi = custom_openapi


@app.get("/openapi.json", include_in_schema=False)
def openapi_json(_user: User = Depends(require_docs_user)):
    return JSONResponse(app.openapi())


@app.get("/docs", include_in_schema=False)
def swagger_docs(_user: User = Depends(require_docs_user)):
    return get_swagger_ui_html(openapi_url="/openapi.json", title="TTM-Todo API")


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

    item_title = None
    notes = None
    if combined:
        if "\n" in combined:
            first, rest = combined.split("\n", 1)
            item_title = first.strip()[:500] or None
            notes = rest.strip() or None
        else:
            item_title = combined[:500]

    uploads = [image] if has_image and image is not None else []
    create_item(
        db,
        user,
        title=item_title,
        notes=notes,
        source="share",
        uploads=uploads,
    )
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
