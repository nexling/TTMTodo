from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from pywebpush import WebPushException, webpush
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import Bucket, Item, PushDelivery, PushSubscription
from app.vapid import vapid_claims, vapid_signer

log = logging.getLogger("magictodo")

LEAD_BODIES = {
    15: "Due in 15 minutes",
    60: "Due in 1 hour",
    1440: "Due in 1 day",
    2880: "Due in 2 days",
    4320: "Due in 3 days",
    10080: "Due in 1 week",
}

KIND_LEAD = "lead"
KIND_NUDGE = "nudge"
KIND_DUE = "due"
MAX_LATENESS = timedelta(hours=24)


def _utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _naive(dt: datetime) -> datetime:
    aware = _utc(dt)
    assert aware is not None
    return aware.replace(tzinfo=None)


def _already_sent(db: Session, item_id: str, kind: str, fire_at: datetime) -> bool:
    return (
        db.scalar(
            select(PushDelivery.id).where(
                PushDelivery.item_id == item_id,
                PushDelivery.kind == kind,
                PushDelivery.fire_at == fire_at,
            )
        )
        is not None
    )


def _record_delivery(db: Session, item_id: str, kind: str, fire_at: datetime) -> None:
    db.add(PushDelivery(item_id=item_id, kind=kind, fire_at=fire_at))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()


def _drop_subscription(db: Session, row: PushSubscription) -> None:
    log.info("Dropping stale push subscription %s", row.id)
    db.delete(row)
    db.commit()


def _send_one(db: Session, row: PushSubscription, payload: dict[str, str]) -> bool:
    """Return True if delivered. False if gone or failed."""
    try:
        webpush(
            subscription_info={
                "endpoint": row.endpoint,
                "keys": {"p256dh": row.p256dh, "auth": row.auth},
            },
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=vapid_signer(),
            vapid_claims=vapid_claims(),
            ttl=86400,
            headers={"Urgency": "high"},
        )
        return True
    except WebPushException as exc:
        if exc.status_code in {404, 410}:
            _drop_subscription(db, row)
            return False
        log.warning("Web push failed for %s: %s", row.id, exc)
        return False
    except Exception:
        log.exception("Web push error for %s", row.id)
        return False


def send_to_user(db: Session, user_id: str, payload: dict[str, str]) -> dict[str, int]:
    """Send to every stored subscription. Returns delivered and original device counts."""
    rows = list(
        db.scalars(select(PushSubscription).where(PushSubscription.user_id == user_id)).all()
    )
    delivered = 0
    for row in rows:
        if _send_one(db, row, payload):
            delivered += 1
    return {"delivered": delivered, "devices": len(rows)}


def _notify_user(db: Session, user_id: str, payload: dict[str, str]) -> tuple[int, int | None]:
    """Returns (delivered_count, remaining_subscriptions). None remaining means no devices."""
    result = send_to_user(db, user_id, payload)
    if result["devices"] == 0:
        return 0, None
    leftover = db.scalar(
        select(PushSubscription.id).where(PushSubscription.user_id == user_id).limit(1)
    )
    return result["delivered"], 0 if leftover is None else 1


def _offer(
    db: Session,
    item: Item,
    kind: str,
    fire_at: datetime,
    payload: dict[str, str],
    sent: int,
    skipped: int,
) -> tuple[int, int]:
    if _already_sent(db, item.id, kind, fire_at):
        return sent, skipped + 1
    delivered, remaining = _notify_user(db, item.user_id, payload)
    if remaining is None:
        return sent, skipped + 1
    if delivered:
        _record_delivery(db, item.id, kind, fire_at)
        return sent + 1, skipped
    return sent, skipped + 1


def item_page_url(db: Session, item: Item) -> str:
    bucket = db.get(Bucket, item.bucket_id)
    path = "/" if bucket is None or bucket.is_inbox else f"/b/{item.bucket_id}"
    return f"{path}?item={item.id}"


def dispatch_due(db: Session, now: datetime | None = None) -> dict[str, int]:
    moment = _utc(now) or datetime.now(timezone.utc)
    sent = 0
    skipped = 0
    from app.notifications import CATEGORY_ITEM_REMINDER, allowed as notify_allowed

    items = list(db.scalars(select(Item).where(Item.status == "open")).all())
    reminder_ok: dict[str, bool] = {}
    for item in items:
        if item.user_id not in reminder_ok:
            reminder_ok[item.user_id] = notify_allowed(db, item.user_id, CATEGORY_ITEM_REMINDER)
        if not reminder_ok[item.user_id]:
            skipped += 1
            continue
        title = (item.title or "").strip() or "Untitled"
        due = _utc(item.due_at)
        if due is not None and item.reminder_lead_minutes and due > moment:
            fire = due - timedelta(minutes=item.reminder_lead_minutes)
            if fire <= moment:
                body = LEAD_BODIES.get(item.reminder_lead_minutes, "Due soon")
                sent, skipped = _offer(
                    db,
                    item,
                    KIND_LEAD,
                    _naive(fire),
                    {"title": title, "body": body, "url": item_page_url(db, item)},
                    sent,
                    skipped,
                )
        if due is not None and due <= moment:
            if moment - due > MAX_LATENESS:
                if not _already_sent(db, item.id, KIND_DUE, _naive(due)):
                    _record_delivery(db, item.id, KIND_DUE, _naive(due))
                skipped += 1
            else:
                sent, skipped = _offer(
                    db,
                    item,
                    KIND_DUE,
                    _naive(due),
                    {"title": title, "body": "Due now", "url": item_page_url(db, item)},
                    sent,
                    skipped,
                )
        remind = _utc(item.remind_at)
        if remind is not None and remind <= moment:
            sent, skipped = _offer(
                db,
                item,
                KIND_NUDGE,
                _naive(remind),
                {"title": title, "body": "Reminder", "url": item_page_url(db, item)},
                sent,
                skipped,
            )
    return {"sent": sent, "skipped": skipped, "open": len(items)}


def cli_dispatch() -> int:
    from app.bootstrap import bootstrap
    from app.mail import dispatch_plan_due_mail

    logging.basicConfig(level=logging.INFO)
    bootstrap()
    with SessionLocal() as db:
        result = dispatch_due(db)
        try:
            mail = dispatch_plan_due_mail(db)
        except Exception:
            log.exception("Plan due email dispatch failed")
            mail = {"sent": 0, "skipped": 0, "tasks": 0}
    print("push sent={sent} skipped={skipped} open={open}".format(**result))
    print("mail sent={sent} skipped={skipped} tasks={tasks}".format(**mail))
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_dispatch())
