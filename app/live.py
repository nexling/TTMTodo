from __future__ import annotations

import asyncio
import json
import logging
import threading
from dataclasses import dataclass, field

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import event, select
from sqlalchemy.orm import Session

log = logging.getLogger("magictodo")

router = APIRouter(tags=["live"])

_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_LIVE_KEY = "live_events"
_ORG_CACHE_KEY = "live_project_org"


@dataclass(eq=False)
class Subscriber:
    user_id: str
    org_ids: set[str]
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))


_subs: set[Subscriber] = set()


def set_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    global _loop
    _loop = loop


def subscribe(user_id: str, org_ids: list[str] | set[str]) -> Subscriber:
    sub = Subscriber(user_id=user_id, org_ids=set(org_ids))
    with _lock:
        _subs.add(sub)
    return sub


def unsubscribe(sub: Subscriber) -> None:
    with _lock:
        _subs.discard(sub)


def _put(sub: Subscriber, event: dict) -> None:
    try:
        sub.queue.put_nowait(event)
        return
    except asyncio.QueueFull:
        pass
    try:
        sub.queue.get_nowait()
    except asyncio.QueueEmpty:
        pass
    try:
        sub.queue.put_nowait(event)
    except asyncio.QueueFull:
        pass


def publish(event: dict) -> None:
    channel = event.get("channel")
    with _lock:
        targets = list(_subs)
    for sub in targets:
        if channel == "inbox":
            if sub.user_id != event.get("user_id"):
                continue
            _put(sub, {"channel": "inbox"})
        elif channel == "plan":
            org_id = event.get("org_id")
            if not org_id or org_id not in sub.org_ids:
                continue
            payload: dict = {"channel": "plan"}
            if event.get("project_id"):
                payload["project_id"] = event["project_id"]
            _put(sub, payload)


def publish_threadsafe(event: dict) -> None:
    loop = _loop
    if loop is None or loop.is_closed():
        return
    try:
        loop.call_soon_threadsafe(publish, event)
    except RuntimeError:
        log.debug("Live publish skipped; event loop is not running")


def _pending(session: Session) -> set[tuple]:
    return session.info.setdefault(_LIVE_KEY, set())


def _note_inbox(session: Session, user_id: str | None) -> None:
    if user_id:
        _pending(session).add(("inbox", user_id, None, None))


def _note_plan(session: Session, org_id: str | None, project_id: str | None) -> None:
    if org_id:
        _pending(session).add(("plan", None, org_id, project_id))


def _project_org(session: Session, project_id: str | None) -> tuple[str | None, str | None]:
    if not project_id:
        return None, None
    cache: dict[str, str | None] = session.info.setdefault(_ORG_CACHE_KEY, {})
    if project_id in cache:
        return cache[project_id], project_id
    from app.models import PlanProject

    proj = session.get(PlanProject, project_id)
    if proj is None:
        for obj in list(session.new) + list(session.dirty) + list(session.deleted):
            if isinstance(obj, PlanProject) and obj.id == project_id:
                proj = obj
                break
    org_id = proj.organization_id if proj is not None else None
    cache[project_id] = org_id
    return org_id, project_id


def _task_project(session: Session, task_id: str | None) -> tuple[str | None, str | None]:
    if not task_id:
        return None, None
    from app.models import PlanTask

    task = session.get(PlanTask, task_id)
    if task is None:
        for obj in list(session.new) + list(session.dirty) + list(session.deleted):
            if isinstance(obj, PlanTask) and obj.id == task_id:
                task = obj
                break
    if task is None:
        return None, None
    return _project_org(session, task.project_id)


@event.listens_for(Session, "after_flush")
def _collect_live_events(session: Session, _ctx) -> None:
    from app.models import Attachment, Bucket, Item, PlanProject, PlanTask, PlanTaskDep

    seen: set[int] = set()
    for obj in list(session.new) + list(session.dirty) + list(session.deleted):
        ident = id(obj)
        if ident in seen:
            continue
        seen.add(ident)
        if isinstance(obj, (Item, Bucket)):
            _note_inbox(session, getattr(obj, "user_id", None))
        elif isinstance(obj, PlanProject):
            _note_plan(session, obj.organization_id, obj.id)
        elif isinstance(obj, PlanTask):
            org_id, project_id = _project_org(session, obj.project_id)
            _note_plan(session, org_id, project_id)
        elif isinstance(obj, PlanTaskDep):
            org_id, project_id = _task_project(session, obj.predecessor_id or obj.successor_id)
            _note_plan(session, org_id, project_id)
        elif isinstance(obj, Attachment):
            if obj.item_id:
                item = session.get(Item, obj.item_id)
                if item is None:
                    for other in list(session.new) + list(session.dirty) + list(session.deleted):
                        if isinstance(other, Item) and other.id == obj.item_id:
                            item = other
                            break
                _note_inbox(session, item.user_id if item is not None else None)
            if obj.plan_task_id:
                org_id, project_id = _task_project(session, obj.plan_task_id)
                _note_plan(session, org_id, project_id)


@event.listens_for(Session, "after_commit")
def _emit_live_events(session: Session) -> None:
    events = session.info.pop(_LIVE_KEY, set())
    session.info.pop(_ORG_CACHE_KEY, None)
    for channel, user_id, org_id, project_id in events:
        if channel == "inbox":
            publish_threadsafe({"channel": "inbox", "user_id": user_id})
        elif channel == "plan":
            publish_threadsafe({"channel": "plan", "org_id": org_id, "project_id": project_id})


@event.listens_for(Session, "after_rollback")
def _clear_live_events(session: Session) -> None:
    session.info.pop(_LIVE_KEY, None)
    session.info.pop(_ORG_CACHE_KEY, None)


@router.get("/api/live")
async def live_stream(request: Request):
    from app.database import SessionLocal
    from app.models import Membership, User
    from app.orgs import MEMBERSHIP_STATUS_ACTIVE, user_is_licensed

    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not signed in")
    org_id = request.session.get("active_organization_id")
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None:
            raise HTTPException(status_code=401, detail="Not signed in")
        if not user_is_licensed(db, user, org_id):
            raise HTTPException(status_code=403, detail="unlicensed")
        org_ids = list(
            db.scalars(
                select(Membership.organization_id).where(
                    Membership.user_id == user.id,
                    Membership.status == MEMBERSHIP_STATUS_ACTIVE,
                )
            ).all()
        )

    sub = subscribe(user.id, org_ids)

    async def events():
        try:
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(sub.queue.get(), timeout=25)
                    yield f"data: {json.dumps(msg, separators=(',', ':'))}\n\n"
                except TimeoutError:
                    yield ": ping\n\n"
        finally:
            unsubscribe(sub)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
