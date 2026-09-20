from __future__ import annotations

import hashlib
import io
import json
import logging
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
import img2pdf
import pikepdf

from app.config import settings
from app.models import Bucket, Item, RemarkableImport, User
from app.routers.items import add_attachment_bytes, next_sort_order, replace_item_image
from app.userfiles import remarkable_config_path, remarkable_key_path, remarkable_status_path

log = logging.getLogger("magictodo")

XOCHITL = "/home/root/.local/share/remarkable/xochitl"
PAGE_W, PAGE_H = 1240, 1754
FONTS = (
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
)


class RemarkableError(Exception):
    pass


@dataclass
class RmSettings:
    host: str
    ssh_user: str
    port: int
    key: Path | None
    folder: str
    out_folder: str
    key_path: str
    status_path: Path

    @property
    def is_configured(self) -> bool:
        return bool(self.host)


_rm: ContextVar[RmSettings | None] = ContextVar("rm_settings", default=None)


def load_settings(user: User) -> RmSettings:
    path = remarkable_config_path(user.id)
    raw: dict = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text())
            if isinstance(loaded, dict):
                raw = loaded
        except (OSError, json.JSONDecodeError):
            raw = {}
    host = str(raw.get("host") or "").strip()
    key_path = str(raw.get("key_path") or "").strip()
    key = Path(key_path) if key_path else None
    if key is not None and not key.is_file():
        key = None
    try:
        port = int(raw.get("port") or 21)
    except (TypeError, ValueError):
        port = 21
    return RmSettings(
        host=host,
        ssh_user=str(raw.get("user") or "root").strip() or "root",
        port=port if 1 <= port <= 65535 else 21,
        key=key,
        folder=str(raw.get("folder") or "TTM-Todo").strip() or "TTM-Todo",
        out_folder=str(raw.get("out_folder") or "From TTM-Todo").strip() or "From TTM-Todo",
        key_path=key_path,
        status_path=remarkable_status_path(user.id),
    )


@contextmanager
def acting_as(user: User) -> Iterator[RmSettings]:
    token = _rm.set(load_settings(user))
    try:
        yield _rm.get()  # type: ignore[misc]
    finally:
        _rm.reset(token)


def _conn() -> RmSettings:
    current = _rm.get()
    if current is None:
        raise RemarkableError("No user for reMarkable")
    return current


def configured() -> bool:
    current = _rm.get()
    return bool(current and current.is_configured)


def _ssh_base() -> list[str]:
    current = _conn()
    args = [
        "-p",
        str(current.port),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]
    if current.key:
        args += ["-i", str(current.key), "-o", "IdentitiesOnly=yes"]
    return args


def _target() -> str:
    current = _conn()
    return f"{current.ssh_user}@{current.host}"


def ssh_run(
    remote_cmd: str,
    *,
    input_bytes: bytes | None = None,
    timeout: int = 45,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["ssh", *_ssh_base(), _target(), remote_cmd],
        input=input_bytes,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def ssh_ok() -> bool:
    try:
        proc = ssh_run("true", timeout=12)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return proc.returncode == 0


def ssh_get_bytes(remote_path: str) -> bytes | None:
    proc = ssh_run(f"cat {shlex.quote(remote_path)}")
    if proc.returncode != 0:
        return None
    return proc.stdout


def ssh_put_bytes(remote_path: str, data: bytes) -> None:
    proc = ssh_run(f"cat > {shlex.quote(remote_path)}", input_bytes=data)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise RemarkableError(err or "Could not write file on tablet")


def ssh_mkdir(remote_path: str) -> None:
    proc = ssh_run(f"mkdir -p {shlex.quote(remote_path)}")
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise RemarkableError(err or "Could not create directory on tablet")


def load_status() -> dict:
    path = _conn().status_path
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_status(payload: dict) -> None:
    path = _conn().status_path
    path.write_text(json.dumps(payload, indent=2))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def status_payload(user: User) -> dict:
    with acting_as(user):
        current = _conn()
        last = load_status()
        return {
            "configured": configured(),
            "host": current.host,
            "user": current.ssh_user,
            "port": current.port,
            "folder": current.folder,
            "out_folder": current.out_folder,
            "key_path": current.key_path,
            "reachable": last.get("reachable"),
            "last_at": last.get("at"),
            "last_ok": last.get("ok"),
            "imported": last.get("imported", 0),
            "updated": last.get("updated", 0),
            "skipped": last.get("skipped", 0),
            "skipped_existing": last.get("skipped_existing", 0),
            "skipped_no_file": last.get("skipped_no_file", 0),
            "skipped_no_image": last.get("skipped_no_image", 0),
            "error": last.get("error"),
        }


def save_connection(
    user: User,
    *,
    host: str,
    ssh_user: str,
    port: int,
    folder: str,
    out_folder: str,
    key_path: str = "",
    private_key: str = "",
) -> dict:
    dest = remarkable_config_path(user.id)
    existing: dict = {}
    if dest.is_file():
        try:
            loaded = json.loads(dest.read_text())
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, json.JSONDecodeError):
            existing = {}
    stored_key = key_path.strip()
    if private_key.strip():
        key_file = remarkable_key_path(user.id)
        text = private_key if private_key.endswith("\n") else private_key + "\n"
        key_file.write_text(text)
        key_file.chmod(0o600)
        stored_key = str(key_file)
    elif not stored_key:
        stored_key = str(existing.get("key_path") or "")
    payload = {
        "host": host.strip(),
        "user": (ssh_user or "root").strip() or "root",
        "port": port,
        "folder": (folder or "TTM-Todo").strip() or "TTM-Todo",
        "out_folder": (out_folder or "From TTM-Todo").strip() or "From TTM-Todo",
        "key_path": stored_key,
    }
    dest.write_text(json.dumps(payload, indent=2))
    dest.chmod(0o600)
    return status_payload(user)


def _is_live(meta: dict) -> bool:
    if meta.get("deleted") is True:
        return False
    if str(meta.get("parent") or "") == "trash":
        return False
    return True


def _fetch_metadata() -> dict[str, dict]:
    proc = ssh_run(
        f"cd {shlex.quote(XOCHITL)} && set -- *.metadata; "
        "[ -e \"$1\" ] && tar cf - \"$@\" || true",
        timeout=90,
    )
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise RemarkableError(err or "Could not list tablet notebooks")
    metas: dict[str, dict] = {}
    if not proc.stdout:
        return metas
    try:
        with tarfile.open(fileobj=io.BytesIO(proc.stdout), mode="r:") as tar:
            for member in tar.getmembers():
                if not member.isfile() or not member.name.endswith(".metadata"):
                    continue
                extracted = tar.extractfile(member)
                if extracted is None:
                    continue
                name = Path(member.name).name
                uid = name[: -len(".metadata")]
                try:
                    metas[uid] = json.loads(extracted.read().decode("utf-8"))
                except json.JSONDecodeError:
                    continue
    except tarfile.TarError as exc:
        raise RemarkableError("Could not parse tablet notebook list") from exc
    return metas


def _folder_id(metas: dict[str, dict], name: str) -> str | None:
    for uid, meta in metas.items():
        if not _is_live(meta):
            continue
        if meta.get("type") == "CollectionType" and meta.get("visibleName") == name:
            return uid
    return None


def _in_folder(doc_id: str, folder_id: str, metas: dict[str, dict]) -> bool:
    current = str((metas.get(doc_id) or {}).get("parent") or "")
    seen: set[str] = set()
    while current and current not in seen:
        if current == folder_id:
            return True
        seen.add(current)
        current = str((metas.get(current) or {}).get("parent") or "")
        if current in ("", "trash"):
            return False
    return False


def _fetch_page_rm(doc_id: str, page_id: str) -> bytes | None:
    direct = ssh_get_bytes(f"{XOCHITL}/{doc_id}/{page_id}.rm")
    if direct:
        return direct
    quoted = shlex.quote(f"{XOCHITL}/{doc_id}")
    proc = ssh_run(
        f"find {quoted} -name '*.rm' 2>/dev/null || true",
        timeout=20,
    )
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        path = line.strip()
        if path and page_id in Path(path).name:
            data = ssh_get_bytes(path)
            if data:
                return data
    return None


def _fetch_thumb(doc_id: str, page_id: str, index: int) -> bytes | None:
    thumb_dir = f"{XOCHITL}/{doc_id}.thumbnails"
    names = [
        f"{page_id}.jpg",
        f"{page_id}.jpeg",
        f"{page_id}.png",
        f"{index}.jpg",
        f"{index}.png",
        f"{index - 1}.jpg",
        f"{index - 1}.png",
    ]
    for name in names:
        data = ssh_get_bytes(f"{thumb_dir}/{name}")
        if data:
            return data
    proc = ssh_run(f"ls {shlex.quote(thumb_dir)} 2>/dev/null || true", timeout=15)
    for name in proc.stdout.decode("utf-8", "replace").split():
        if page_id in name and name.lower().endswith((".jpg", ".jpeg", ".png")):
            data = ssh_get_bytes(f"{thumb_dir}/{name}")
            if data:
                return data
    return None


def _page_ids(content: dict) -> list[str]:
    pages = content.get("pages")
    if isinstance(pages, list) and pages and isinstance(pages[0], str):
        return [str(p) for p in pages]
    raw = (content.get("cPages") or {}).get("pages") or []
    ids: list[str] = []
    for page in raw:
        if isinstance(page, dict) and page.get("id"):
            ids.append(str(page["id"]))
        elif isinstance(page, str):
            ids.append(page)
    return ids


def _rmc_bin() -> str | None:
    local = Path(sys.executable).parent / "rmc"
    if local.is_file():
        return str(local)
    return _which("rmc")


def _fitz_png(data: bytes, kind: str) -> bytes | None:
    try:
        import pymupdf
    except ImportError:
        return None
    try:
        doc = pymupdf.open(stream=data, filetype=kind)
        if doc.page_count < 1:
            return None
        pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
        return pix.tobytes("png")
    except Exception:
        log.debug("PyMuPDF could not rasterize %s", kind, exc_info=True)
        return None


def _rmc_svg_inprocess(rm_path: Path) -> bytes | None:
    try:
        from rmscene import read_tree
        from rmc.exporters.svg import tree_to_svg
    except ImportError:
        return None
    try:
        buf = io.StringIO()
        with rm_path.open("rb") as handle:
            tree_to_svg(read_tree(handle), buf)
        text = buf.getvalue()
        return text.encode("utf-8") if text.strip() else None
    except Exception:
        log.debug("rmc in-process SVG export failed", exc_info=True)
        return None


def _try_rmc_png(rm_bytes: bytes | None, work: Path) -> bytes | None:
    if not rm_bytes:
        return None
    rm_path = work / "page.rm"
    rm_path.write_bytes(rm_bytes)

    svg_bytes = _rmc_svg_inprocess(rm_path)
    if svg_bytes:
        png = _fitz_png(svg_bytes, "svg")
        if png:
            return png
        dest = work / "page.svg"
        dest.write_bytes(svg_bytes)
        converted = _svg_to_png(dest)
        if converted:
            return converted

    rmc = _rmc_bin()
    if not rmc:
        log.debug("rmc is not installed; cannot render .rm without a thumbnail")
        return None
    # PyPI rmc 0.3.0 has no --no-chrome; PDF needs Inkscape. Prefer SVG.
    for fmt, kind in (("svg", "svg"), ("pdf", "pdf")):
        dest = work / f"page.{fmt}"
        try:
            proc = subprocess.run(
                [rmc, "-t", fmt, "-o", str(dest), str(rm_path)],
                capture_output=True,
                timeout=90,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if proc.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
            err = (proc.stderr or b"").decode("utf-8", "replace").strip()
            log.debug("rmc -t %s failed: %s", fmt, err or f"exit {proc.returncode}")
            continue
        png = _fitz_png(dest.read_bytes(), kind)
        if png:
            return png
        if fmt == "svg":
            converted = _svg_to_png(dest)
            if converted:
                return converted
    return None


def _which(name: str) -> str | None:
    from shutil import which

    return which(name)


def _svg_to_png(svg_path: Path) -> bytes | None:
    convert = _which("rsvg-convert")
    if not convert:
        return None
    try:
        proc = subprocess.run(
            [convert, "-f", "png", str(svg_path)],
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    return proc.stdout


def _load_font(size: int) -> ImageFont.ImageFont:
    for path in FONTS:
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    lines: list[str] = []
    for para in (text or "").split("\n"):
        if not para:
            lines.append("")
            continue
        current = ""
        for word in para.split(" "):
            trial = f"{current} {word}".strip()
            if draw.textlength(trial, font=font) <= max_width:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = word
        lines.append(current)
    return lines


def _inbox(db: Session, user: User) -> Bucket:
    inbox = db.scalar(
        select(Bucket).where(Bucket.user_id == user.id, Bucket.is_inbox.is_(True))
    )
    if inbox is None:
        raise RemarkableError("Inbox missing")
    return inbox


def pull(db: Session, user: User) -> dict:
    with acting_as(user):
        return _pull(db, user)


def _pull(db: Session, user: User) -> dict:
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "ok": False,
        "reachable": False,
        "imported": 0,
        "updated": 0,
        "skipped": 0,
        "skipped_existing": 0,
        "skipped_no_file": 0,
        "skipped_no_image": 0,
        "error": None,
    }
    current = _conn()
    if not configured():
        result["error"] = "host not set"
        save_status(result)
        return result
    if not ssh_ok():
        result["error"] = "Tablet unreachable over SSH"
        save_status(result)
        return result
    result["reachable"] = True

    try:
        metas = _fetch_metadata()
        folder_id = _folder_id(metas, current.folder)
        if folder_id is None:
            result["ok"] = True
            result["error"] = f'No folder named “{current.folder}” on the tablet'
            save_status(result)
            return result

        docs = [
            uid
            for uid, meta in metas.items()
            if _is_live(meta)
            and meta.get("type") == "DocumentType"
            and _in_folder(uid, folder_id, metas)
        ]
        inbox = _inbox(db, user)
        with tempfile.TemporaryDirectory(prefix="magictodo-rm-") as raw:
            work = Path(raw)
            for doc_id in docs:
                name = str((metas[doc_id].get("visibleName") or "Notebook")).strip() or "Notebook"
                content_raw = ssh_get_bytes(f"{XOCHITL}/{doc_id}.content")
                content = json.loads(content_raw.decode("utf-8")) if content_raw else {}
                pages = _page_ids(content)
                for index, page_id in enumerate(pages, start=1):
                    rm_bytes = _fetch_page_rm(doc_id, page_id)
                    thumb = _fetch_thumb(doc_id, page_id, index)
                    if rm_bytes:
                        digest = hashlib.sha256(rm_bytes).hexdigest()
                    elif thumb:
                        digest = hashlib.sha256(thumb).hexdigest()
                    else:
                        log.info(
                            "reMarkable page not flushed yet (%s p.%s); close the notebook on the tablet",
                            name,
                            index,
                        )
                        result["skipped_no_file"] += 1
                        result["skipped"] += 1
                        continue

                    row = db.scalar(
                        select(RemarkableImport).where(
                            RemarkableImport.user_id == user.id,
                            RemarkableImport.doc_uuid == doc_id,
                            RemarkableImport.page_id == page_id,
                        )
                    )
                    existing = db.get(Item, row.item_id) if row and row.item_id else None
                    if row and row.page_hash == digest and existing is not None:
                        result["skipped_existing"] += 1
                        result["skipped"] += 1
                        continue

                    png = _try_rmc_png(rm_bytes, work)
                    image_bytes = png or thumb
                    if not image_bytes:
                        result["skipped_no_image"] += 1
                        result["skipped"] += 1
                        continue
                    filename = "page.png" if png else "page.jpg"

                    title = f"{name} · p.{index}"[:500]
                    if existing is not None:
                        replace_item_image(db, existing, image_bytes, filename)
                        existing.title = title
                        existing.source = "remarkable"
                        row.page_hash = digest
                        row.updated_at = datetime.now(timezone.utc)
                        result["updated"] += 1
                    else:
                        item = Item(
                            user_id=user.id,
                            bucket_id=inbox.id,
                            title=title,
                            notes=None,
                            source="remarkable",
                            status="open",
                            sort_order=next_sort_order(db, user, inbox.id, None, prepend=True),
                        )
                        db.add(item)
                        db.flush()
                        add_attachment_bytes(db, item, image_bytes, filename)
                        if row is None:
                            row = RemarkableImport(
                                user_id=user.id,
                                doc_uuid=doc_id,
                                page_id=page_id,
                                page_hash=digest,
                                item_id=item.id,
                            )
                            db.add(row)
                        else:
                            row.page_hash = digest
                            row.item_id = item.id
                            row.updated_at = datetime.now(timezone.utc)
                        result["imported"] += 1
        db.commit()
        result["ok"] = True
        result["error"] = None
    except subprocess.TimeoutExpired:
        db.rollback()
        result["error"] = "SSH timed out"
    except RemarkableError as exc:
        db.rollback()
        result["error"] = str(exc)
    except Exception as exc:
        db.rollback()
        log.exception("reMarkable pull failed")
        result["error"] = str(exc)
    save_status(result)
    return result


def _rm_now() -> str:
    return str(int(time.time() * 1000))


def _ensure_out_folder(metas: dict[str, dict]) -> str:
    name = _conn().out_folder
    existing = _folder_id(metas, name)
    if existing:
        return existing
    folder_id = str(uuid.uuid4())
    meta = {
        "deleted": False,
        "lastModified": _rm_now(),
        "modified": True,
        "parent": "",
        "pinned": False,
        "synced": False,
        "type": "CollectionType",
        "version": 1,
        "visibleName": name,
    }
    ssh_put_bytes(f"{XOCHITL}/{folder_id}.metadata", json.dumps(meta).encode("utf-8"))
    ssh_put_bytes(f"{XOCHITL}/{folder_id}.content", json.dumps({"tags": []}).encode("utf-8"))
    return folder_id


def _is_blank_page(img: Image.Image) -> bool:
    extrema = img.convert("L").getextrema()
    return extrema == (255, 255)


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _item_pdf(item: Item) -> bytes:
    font_title = _load_font(36)
    font_body = _load_font(22)
    pages: list[Image.Image] = []
    canvas = Image.new("RGB", (PAGE_W, PAGE_H), "white")
    draw = ImageDraw.Draw(canvas)
    y = 48
    margin = 48
    max_w = PAGE_W - margin * 2
    dirty = False
    bottom = PAGE_H - 48

    def new_page() -> None:
        nonlocal canvas, draw, y, dirty
        canvas = Image.new("RGB", (PAGE_W, PAGE_H), "white")
        draw = ImageDraw.Draw(canvas)
        y = 48
        dirty = False

    def commit_page() -> None:
        nonlocal dirty
        if dirty and not _is_blank_page(canvas):
            pages.append(canvas)
        dirty = False

    def ensure_space(need: int) -> None:
        nonlocal y
        if y + need > bottom and dirty:
            commit_page()
            new_page()

    title = (item.title or "Untitled").strip() or "Untitled"
    for line in _wrap(draw, title, font_title, max_w):
        ensure_space(44)
        draw.text((margin, y), line, fill=(20, 16, 10), font=font_title)
        y += 44
        dirty = True
    y += 12
    notes = (item.notes or "").strip()
    if notes:
        for line in _wrap(draw, notes, font_body, max_w):
            ensure_space(30)
            draw.text((margin, y), line, fill=(60, 52, 40), font=font_body)
            y += 30
            dirty = True
        y += 16
    for att in item.attachments:
        path = settings.upload_dir / att.stored_name
        if not path.is_file():
            continue
        try:
            photo = Image.open(path).convert("RGB")
        except (UnidentifiedImageError, OSError):
            continue
        remaining = bottom - y
        if remaining < 200 and dirty:
            commit_page()
            new_page()
            remaining = bottom - y
        photo.thumbnail((max_w, max(remaining, 200)))
        canvas.paste(photo, (margin, y))
        y += photo.height + 24
        dirty = True
    commit_page()
    if not pages:
        pages = [canvas]
    return bytes(img2pdf.convert([_png_bytes(page) for page in pages]))


def _web_upload(pdf: bytes, folder_id: str, filename: str) -> bool:
    remote_pdf = f"/tmp/magictodo-{uuid.uuid4().hex}.pdf"
    ssh_put_bytes(remote_pdf, pdf)
    cmd = (
        f"curl -sS -o /dev/null http://10.11.99.1/documents/{folder_id} && "
        f"curl -sS -o /dev/null -w '%{{http_code}}' "
        f'-F "file=@{remote_pdf};filename={filename};type=application/pdf" '
        f"http://10.11.99.1/upload; rm -f {remote_pdf}"
    )
    try:
        proc = ssh_run(cmd, timeout=90)
    except subprocess.TimeoutExpired:
        return False
    code = (proc.stdout or b"").decode("utf-8", "replace").strip()
    return proc.returncode == 0 and code in {"200", "201", "204"}


def _pdf_page_count(pdf: bytes) -> int:
    with pikepdf.open(io.BytesIO(pdf)) as doc:
        return max(len(doc.pages), 1)


def _inject_pdf(pdf: bytes, folder_id: str, title: str) -> str:
    doc_id = str(uuid.uuid4())
    n_pages = _pdf_page_count(pdf)
    page_ids = [str(uuid.uuid4()) for _ in range(n_pages)]
    now = _rm_now()
    meta = {
        "deleted": False,
        "lastModified": now,
        "lastOpened": now,
        "lastOpenedPage": 0,
        "metadatamodified": True,
        "modified": True,
        "parent": folder_id,
        "pinned": False,
        "synced": False,
        "type": "DocumentType",
        "version": 1,
        "visibleName": title[:80],
    }
    content = {
        "cPages": {
            "lastOpened": {"value": page_ids[0]},
            "pages": [
                {"id": page_id, "redir": {"value": index}}
                for index, page_id in enumerate(page_ids)
            ],
        },
        "coverPageNumber": 0,
        "dummyDocument": False,
        "extraMetadata": {},
        "fileType": "pdf",
        "fontName": "",
        "formatVersion": 2,
        "lineHeight": -1,
        "margins": 100,
        "orientation": "portrait",
        "pageCount": n_pages,
        "sizeInBytes": str(len(pdf)),
        "textAlignment": "left",
        "textScale": 1,
        "zoomMode": "bestFit",
    }
    ssh_put_bytes(f"{XOCHITL}/{doc_id}.metadata", json.dumps(meta).encode("utf-8"))
    ssh_put_bytes(f"{XOCHITL}/{doc_id}.content", json.dumps(content).encode("utf-8"))
    ssh_put_bytes(f"{XOCHITL}/{doc_id}.pdf", pdf)
    return doc_id


def _restart_xochitl() -> None:
    proc = ssh_run("systemctl restart xochitl", timeout=30)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise RemarkableError(err or "Could not restart xochitl")


def push_item(db: Session, user: User, item_id: str) -> dict:
    with acting_as(user):
        if not configured():
            raise RemarkableError("host not set")
        if not ssh_ok():
            raise RemarkableError("Tablet unreachable over SSH")
        item = db.scalar(
            select(Item)
            .options(selectinload(Item.attachments))
            .where(Item.id == item_id, Item.user_id == user.id)
        )
        if item is None:
            raise RemarkableError("Item not found")
        if item.parent_id:
            raise RemarkableError("Send the parent item, not a step")
        pdf = _item_pdf(item)
        metas = _fetch_metadata()
        folder_id = _ensure_out_folder(metas)
        title = (item.title or "TTM-Todo").split("\n", 1)[0].strip() or "TTM-Todo"
        safe = "".join(c if c.isalnum() or c in "._- " else "_" for c in title)[:40] or "todo"
        filename = f"{safe}.pdf"
        if _web_upload(pdf, folder_id, filename):
            return {"ok": True, "method": "web", "document_id": None}
        doc_id = _inject_pdf(pdf, folder_id, title)
        _restart_xochitl()
        return {"ok": True, "method": "files", "document_id": doc_id}


def cli_pull() -> int:
    from app.bootstrap import bootstrap
    from app.database import SessionLocal

    bootstrap()
    any_cfg = False
    failed = False
    with SessionLocal() as db:
        users = list(db.scalars(select(User).order_by(User.created_at.asc())).all())
        if not users:
            print("No TTM-Todo user yet")
            return 1
        for user in users:
            with acting_as(user):
                if not configured():
                    continue
                any_cfg = True
                try:
                    result = pull(db, user)
                except Exception as exc:
                    print(f"{user.username}: {exc}")
                    failed = True
                    continue
            if result.get("error") and not result.get("ok"):
                print(f"{user.username}: {result['error']}")
                if result.get("error") in {
                    "Tablet unreachable over SSH",
                    "host not set",
                    "REMARKABLE_HOST is not set",
                }:
                    continue
                failed = True
                continue
            print(
                "{name}: imported={imported} updated={updated} skipped_existing={skipped_existing} "
                "skipped_no_file={skipped_no_file} skipped_no_image={skipped_no_image}".format(
                    name=user.username,
                    **result,
                )
            )
    if not any_cfg:
        print("No reMarkable tablet configured")
        return 0
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(cli_pull())
