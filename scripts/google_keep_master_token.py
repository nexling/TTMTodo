#!/usr/bin/env python3
"""Exchange a Google EmbeddedSetup oauth_token cookie for a Keep master token.

The Android device id is the one TTM-Todo already stores for --username
in data/users/<id>/google.json. Using a different id than Settings → Connect
Keep often yields BadAuthentication.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


INSTRUCTIONS = """
Mint a Google Keep master token for TTM-Todo
=============================================

1. Open https://accounts.google.com/EmbeddedSetup and sign in as the Gmail
   that owns Keep. The page often hangs on a spinner. That is expected.
2. DevTools → Application → Cookies → accounts.google.com → copy oauth_token.
3. Paste that cookie below (it will not echo). This script prints a master
   Token. Paste that Token into Settings → Connect Keep for the same username.

Do not commit the token, put it in .env, paste it in chat, or screenshot it.
It has full access to the Google account.
""".strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Mint a Keep master token for one TTM-Todo user")
    parser.add_argument(
        "--username",
        required=True,
        help="TTM-Todo username whose Keep device_id should be reused",
    )
    args = parser.parse_args()

    print(INSTRUCTIONS)
    print()
    email = input("Keep email: ").strip()
    oauth_token = getpass.getpass("oauth_token cookie: ").strip()
    if "@" not in email or not oauth_token:
        print("Email and oauth_token are required.", file=sys.stderr)
        return 1

    from sqlalchemy import select

    from app.bootstrap import bootstrap
    from app.database import SessionLocal
    from app.google_lists import ensure_keep_device_id
    from app.models import User

    bootstrap()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == args.username.strip()))
        if user is None:
            print(f"Unknown TTM-Todo username: {args.username.strip()}", file=sys.stderr)
            return 1
        device_id = ensure_keep_device_id(user)
    print(f"Using TTM-Todo Keep device_id {device_id} for {user.username}")

    import gpsoauth

    try:
        result = gpsoauth.exchange_token(email, oauth_token, device_id)
    except Exception as exc:
        print(f"Exchange request failed: {exc}", file=sys.stderr)
        return 1

    token = (result.get("Token") or "").strip()
    err = result.get("Error")
    if not token:
        detail = result.get("ErrorDetail") or ""
        print(f"Exchange failed: {err or 'no Token in response'} {detail}".strip(), file=sys.stderr)
        print("Get a fresh oauth_token cookie (they expire quickly).", file=sys.stderr)
        return 1

    print()
    print("Master token (paste into Settings → Connect Keep):")
    print(token)
    print()
    print("Do not commit this, paste it in chat, or screenshot it.")

    try:
        check = input("Test Keep login with this token? [y/N]: ").strip().lower()
    except EOFError:
        check = ""
    if check not in {"y", "yes"}:
        return 0

    import gkeepapi

    keep = gkeepapi.Keep()
    try:
        keep.authenticate(email, token, sync=True, device_id=device_id)
    except Exception as exc:
        print(f"Keep rejected the token: {exc}", file=sys.stderr)
        print("Use the same email as the cookie, and this helper (same device_id).", file=sys.stderr)
        return 1

    try:
        from gkeepapi.node import List as KeepList
    except ImportError:
        KeepList = None

    titles: list[str] = []
    for note in keep.all():
        is_list = KeepList is not None and isinstance(note, KeepList)
        is_list = is_list or (type(note).__name__ == "List" and hasattr(note, "unchecked"))
        if not is_list:
            continue
        if getattr(note, "trashed", False) or getattr(note, "archived", False):
            continue
        titles.append(str(getattr(note, "title", "") or "").strip() or "(untitled list)")
    print(f"Keep accepted the token. {len(titles)} list(s):")
    for title in sorted(titles, key=str.casefold):
        print(f"  - {title}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
