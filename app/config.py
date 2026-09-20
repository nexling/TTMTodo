from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    secret_key: str = "dev-only-change-me"
    host: str = "127.0.0.1"
    port: int = 8010
    session_https_only: bool = False
    magictodo_user: str | None = None
    magictodo_password: str | None = None
    public_url: str = ""
    data_dir: Path = ROOT_DIR / "data"
    max_upload_bytes: int = 32 * 1024 * 1024
    remarkable_host: str = ""
    remarkable_user: str = "root"
    remarkable_ssh_port: int = 21
    remarkable_ssh_key: Path | None = None
    remarkable_folder: str = "TTM-Todo"
    remarkable_out_folder: str = "From TTM-Todo"
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = ""
    microsoft_client_id: str = ""
    microsoft_client_secret: str = ""
    microsoft_tenant: str = "common"
    microsoft_redirect_uri: str = ""
    auth0_enabled: bool | None = None
    auth0_domain: str = ""
    auth0_client_id: str = ""
    auth0_client_secret: str = ""
    auth0_audience: str = ""
    auth0_scope: str = "openid profile email"
    site_admin_emails: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_starttls: bool = True
    smtp_ssl: bool = False
    mail_timezone: str = "Europe/Stockholm"

    @property
    def auth0_is_enabled(self) -> bool:
        has_config = bool(self.auth0_domain.strip() and self.auth0_client_id.strip() and self.auth0_client_secret.strip())
        if self.auth0_enabled is None:
            return has_config
        return bool(self.auth0_enabled)

    @property
    def site_admin_email_set(self) -> frozenset[str]:
        emails = []
        for raw in self.site_admin_emails.replace(";", ",").replace("\n", ",").split(","):
            email = raw.strip().lower()
            if email and email not in emails:
                emails.append(email)
        return frozenset(emails)

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "magictodo.db"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.database_path}"

    @property
    def remarkable_status_path(self) -> Path:
        return self.data_dir / "remarkable_status.json"

    @property
    def google_config_path(self) -> Path:
        return self.data_dir / "google.json"

    @property
    def google_status_path(self) -> Path:
        return self.data_dir / "google_status.json"


settings = Settings()
