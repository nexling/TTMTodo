from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_licensed
from app.models import ApiToken, User
from app.schemas import TokenCreateIn, TokenOut
from app.security import hash_token, new_api_token, token_prefix

router = APIRouter(prefix="/api/tokens", tags=["tokens"])


def _to_out(row: ApiToken, token: str | None = None) -> TokenOut:
    return TokenOut(
        id=row.id,
        name=row.name,
        prefix=row.prefix,
        created_at=row.created_at,
        last_used_at=row.last_used_at,
        token=token,
    )


@router.get("", response_model=list[TokenOut])
def list_tokens(user: User = Depends(require_licensed), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(ApiToken)
        .where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
        .order_by(ApiToken.created_at.desc())
    ).all()
    return [_to_out(r) for r in rows]


@router.post("", response_model=TokenOut)
def create_token(
    body: TokenCreateIn,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    raw = new_api_token()
    row = ApiToken(
        user_id=user.id,
        name=body.name.strip(),
        token_hash=hash_token(raw),
        prefix=token_prefix(raw),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row, token=raw)


@router.delete("/{token_id}")
def revoke_token(
    token_id: str,
    user: User = Depends(require_licensed),
    db: Session = Depends(get_db),
):
    row = db.get(ApiToken, token_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="Token not found")
    row.revoked_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}
