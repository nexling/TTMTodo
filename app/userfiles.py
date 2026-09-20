from pathlib import Path

from app.config import settings


def user_data_dir(user_id: str) -> Path:
    path = settings.data_dir / "users" / user_id
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return path


def google_config_path(user_id: str) -> Path:
    return user_data_dir(user_id) / "google.json"


def google_status_path(user_id: str) -> Path:
    return user_data_dir(user_id) / "google_status.json"


def remarkable_config_path(user_id: str) -> Path:
    return user_data_dir(user_id) / "remarkable.json"


def remarkable_status_path(user_id: str) -> Path:
    return user_data_dir(user_id) / "remarkable_status.json"


def remarkable_key_path(user_id: str) -> Path:
    return user_data_dir(user_id) / "remarkable_key"


def outlook_config_path(user_id: str) -> Path:
    return user_data_dir(user_id) / "outlook.json"


def ical_config_path(user_id: str) -> Path:
    return user_data_dir(user_id) / "ical.json"


def calendar_export_path(user_id: str) -> Path:
    return user_data_dir(user_id) / "calendar_export.json"
