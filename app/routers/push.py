from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_licensed
from app.models import PushSubscription, User
from app.push import send_to_user
from app.schemas import PushSubscribeIn, PushUnsubscribeIn
from app.vapid import vapid_public_key

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/vapid")
def get_vapid(user: User = Depends(require_licensed)):
    return {"publicKey": vapid_public_key()}


@router.post("/subscribe")
def subscribe(
    body: PushSubscribeIn,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    endpoint = body.endpoint.strip()
    row = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == endpoint))
    if row is None:
        row = PushSubscription(
            user_id=user.id,
            endpoint=endpoint,
            p256dh=body.keys.p256dh,
            auth=body.keys.auth,
        )
        db.add(row)
    else:
        row.user_id = user.id
        row.p256dh = body.keys.p256dh
        row.auth = body.keys.auth
    db.commit()
    return {"ok": True}


@router.delete("/subscribe")
def unsubscribe(
    body: PushUnsubscribeIn,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    endpoint = body.endpoint.strip()
    row = db.scalar(
        select(PushSubscription).where(
            PushSubscription.endpoint == endpoint,
            PushSubscription.user_id == user.id,
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Subscription not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/test")
def test_push(
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    result = send_to_user(
        db,
        user.id,
        {"title": "TTM-Todo", "body": "Test notification", "url": "/"},
    )
    return result
