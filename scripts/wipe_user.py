#!/usr/bin/env python3
"""Wipe a TTM-Todo user on this box. Operator-only. Does not revoke Auth0 or Microsoft.

Usage:
  .venv/bin/python scripts/wipe_user.py user@example.com
  .venv/bin/python scripts/wipe_user.py user@example.com --delete-owned-orgs
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.database import SessionLocal
from app.offboard import OffboardError, find_user, owned_organizations, wipe_user


def main() -> int:
    parser = argparse.ArgumentParser(description="Wipe a TTM-Todo user from this server")
    parser.add_argument("user", help="User id, email, or username")
    parser.add_argument(
        "--delete-owned-orgs",
        action="store_true",
        help="Also delete organizations this user owns, including Plan projects and files",
    )
    parser.add_argument("-y", "--yes", action="store_true", help="Do not prompt")
    args = parser.parse_args()

    with SessionLocal() as db:
        try:
            user = find_user(db, args.user)
        except OffboardError as exc:
            print(exc, file=sys.stderr)
            return 1
        owned = owned_organizations(db, user)
        print(f"Wipe {user.username} id={user.id} email={user.email or '-'}")
        if owned:
            print("Owns organizations:", ", ".join(org.name for org in owned))
        if not args.yes:
            prompt = "Type the username to confirm: "
            if input(prompt).strip() != user.username:
                print("Aborted")
                return 1
        try:
            summary = wipe_user(db, user, delete_owned_orgs=args.delete_owned_orgs)
        except OffboardError as exc:
            print(exc, file=sys.stderr)
            return 1
        db.commit()
        print("Wiped:", summary)
        print("Auth0 and Microsoft/Outlook grants were not revoked. The person should sign out of those providers.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
