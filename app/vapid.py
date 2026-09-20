from __future__ import annotations

import base64
import json
import logging
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid

from app.config import settings

log = logging.getLogger("magictodo")


def vapid_path() -> Path:
    return settings.data_dir / "vapid.json"


def vapid_claims() -> dict[str, str]:
    url = settings.public_url.strip()
    if url.startswith("mailto:") or url.startswith("https://") or url.startswith("http://"):
        if url.startswith("http://"):
            return {"sub": "mailto:magictodo@localhost"}
        return {"sub": url}
    return {"sub": "mailto:magictodo@localhost"}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _generate_keys() -> dict[str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    numbers = key.public_key().public_numbers()
    public_key = _b64url(b"\x04" + numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big"))
    return {"private_key": private_pem, "public_key": public_key}


def ensure_vapid_keys() -> dict[str, str]:
    path = vapid_path()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        if data.get("private_key") and data.get("public_key"):
            return {"private_key": data["private_key"], "public_key": data["public_key"]}
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    keys = _generate_keys()
    path.write_text(json.dumps(keys, indent=2) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    log.info("Generated VAPID keys at %s", path)
    return keys


def vapid_public_key() -> str:
    return ensure_vapid_keys()["public_key"]


def vapid_private_key() -> str:
    return ensure_vapid_keys()["private_key"]


def vapid_signer() -> Vapid:
    """Load the stored PKCS8 PEM. pywebpush's from_string() cannot parse PEM."""
    pem = ensure_vapid_keys()["private_key"].encode("utf-8")
    return Vapid.from_pem(pem)
