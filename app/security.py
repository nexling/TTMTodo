from __future__ import annotations

import hashlib
import io
import re
import secrets
import uuid
from pathlib import Path

import bcrypt
from fastapi import HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from app.config import settings

ALLOWED_IMAGE_FORMATS = {
    "JPEG": ("image/jpeg", ".jpg"),
    "PNG": ("image/png", ".png"),
    "WEBP": ("image/webp", ".webp"),
    "GIF": ("image/gif", ".gif"),
}

TEXT_EXTS = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
}

DOC_EXTS = {
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".rtf": "application/rtf",
}

BLOCKED_EXTS = {".html", ".htm", ".svg", ".xml", ".js", ".mjs"}
BLOCKED_MIMES = {
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
}

HEX_COLOR = re.compile(r"^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def new_api_token() -> str:
    return "mt_" + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_prefix(token: str) -> str:
    return token[:12]


def validate_color(color: str) -> str:
    if not HEX_COLOR.match(color):
        raise HTTPException(status_code=400, detail="Color must be a hex value like #e8a54b")
    return color.lower()


def _original_name(upload: UploadFile, fallback: str) -> str:
    name = Path(upload.filename or fallback).name.strip()
    return name or fallback


def read_upload(upload: UploadFile) -> tuple[bytes, str, str, str]:
    """Return (data, mime, ext, original_name)."""
    data = upload.file.read()
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="File is larger than 32 MB")
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    original = _original_name(upload, "upload")
    ext = Path(original).suffix.lower()
    declared = (upload.content_type or "").split(";")[0].strip().lower()

    if ext in BLOCKED_EXTS or declared in BLOCKED_MIMES:
        raise HTTPException(status_code=400, detail="HTML and script files are not allowed")

    try:
        image = Image.open(io.BytesIO(data))
        image.verify()
        fmt = (image.format or "").upper()
    except (UnidentifiedImageError, OSError):
        fmt = ""
    if fmt in ALLOWED_IMAGE_FORMATS:
        mime, img_ext = ALLOWED_IMAGE_FORMATS[fmt]
        if not original.lower().endswith(img_ext) and ext not in {".jpeg", ".jpg", ".png", ".webp", ".gif"}:
            original = f"{Path(original).stem or 'image'}{img_ext}"
        return data, mime, img_ext, original

    if data.startswith(b"%PDF-"):
        name = original if ext == ".pdf" else f"{Path(original).stem or 'document'}.pdf"
        return data, "application/pdf", ".pdf", name

    if ext in TEXT_EXTS or declared.startswith("text/") or declared == "application/json":
        if ext in BLOCKED_EXTS or declared in BLOCKED_MIMES or "html" in declared:
            raise HTTPException(status_code=400, detail="HTML and script files are not allowed")
        if b"\x00" in data:
            raise HTTPException(status_code=400, detail="Text file looks binary")
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=400, detail="Text file is not valid UTF-8") from exc
        mime = TEXT_EXTS.get(ext) or (declared if declared.startswith("text/") or declared == "application/json" else "text/plain")
        out_ext = ext if ext in TEXT_EXTS else (".json" if mime == "application/json" else ".txt")
        return data, mime, out_ext, original if ext else f"{Path(original).stem or 'note'}{out_ext}"

    if ext in DOC_EXTS:
        return data, DOC_EXTS[ext], ext, original

    raise HTTPException(
        status_code=400,
        detail="Use JPEG, PNG, WebP, GIF, PDF, text, or a common office document",
    )


def read_image_upload(upload: UploadFile) -> tuple[bytes, str, str, str]:
    return read_upload(upload)


def store_upload(data: bytes, ext: str) -> str:
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}{ext}"
    path = settings.upload_dir / stored_name
    path.write_bytes(data)
    return stored_name


def store_image(data: bytes, ext: str) -> str:
    return store_upload(data, ext)
