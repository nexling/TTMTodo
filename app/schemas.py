from datetime import datetime

from pydantic import BaseModel, Field


class StatusOut(BaseModel):
    setup_required: bool
    user: "UserOut | None" = None
    public_url: str = ""


class UserOut(BaseModel):
    id: str
    username: str
    email: str | None = None
    name: str | None = None
    is_admin: bool = False

    model_config = {"from_attributes": True}


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


class SetupIn(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)


class PasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class BucketIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#7c9a6d", max_length=16)
    parent_id: str | None = None


class BucketUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = Field(default=None, max_length=16)
    sort_order: int | None = None
    parent_id: str | None = None


class BucketOut(BaseModel):
    id: str
    name: str
    color: str
    sort_order: int
    is_inbox: bool
    parent_id: str | None = None
    organization_id: str | None = None
    plan_project_id: str | None = None
    locked: bool = False
    open_count: int = 0

    model_config = {"from_attributes": True}


class AttachmentOut(BaseModel):
    id: str
    original_name: str
    mime_type: str
    size: int
    url: str

    model_config = {"from_attributes": True}


class ItemOut(BaseModel):
    id: str
    bucket_id: str
    parent_id: str | None = None
    title: str | None
    notes: str | None
    status: str
    source: str
    created_at: datetime
    completed_at: datetime | None
    due_at: datetime | None = None
    reminder_lead_minutes: int | None = None
    remind_at: datetime | None = None
    recur_interval: int | None = None
    recur_unit: str | None = None
    ocr_text: str | None = None
    ai_priority: int | None = None
    ai_summary: str | None = None
    attachments: list[AttachmentOut] = []
    subtasks: list["ItemOut"] = []
    sort_order: int = 0
    plan_task_id: str | None = None

    model_config = {"from_attributes": True}


ItemOut.model_rebuild()


class InboxCaptureIn(BaseModel):
    text: str | None = None
    source: str | None = "api"


REMINDER_LEAD_MINUTES = (15, 60, 1440, 2880, 4320, 10080)
RECUR_UNITS = ("day", "week", "month", "year")
MAX_NEST_DEPTH = 20


class ItemUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=500)
    notes: str | None = None
    bucket_id: str | None = None
    parent_id: str | None = None
    status: str | None = Field(default=None, pattern="^(open|done)$")
    due_at: datetime | None = None
    reminder_lead_minutes: int | None = None
    remind_at: datetime | None = None
    recur_interval: int | None = Field(default=None, ge=1, le=999)
    recur_unit: str | None = None


class ReorderIn(BaseModel):
    ids: list[str] = Field(min_length=1)


class PushKeysIn(BaseModel):
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=200)


class PushSubscribeIn(BaseModel):
    endpoint: str = Field(min_length=8, max_length=2048)
    keys: PushKeysIn


class PushUnsubscribeIn(BaseModel):
    endpoint: str = Field(min_length=8, max_length=2048)


class TokenCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class TokenOut(BaseModel):
    id: str
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None
    token: str | None = None

    model_config = {"from_attributes": True}


class RemarkableStatusOut(BaseModel):
    configured: bool
    host: str = ""
    user: str = ""
    port: int = 21
    folder: str = ""
    out_folder: str = ""
    key_path: str = ""
    reachable: bool | None = None
    last_at: str | None = None
    last_ok: bool | None = None
    imported: int = 0
    updated: int = 0
    skipped: int = 0
    skipped_existing: int = 0
    skipped_no_file: int = 0
    skipped_no_image: int = 0
    error: str | None = None


class RemarkablePushOut(BaseModel):
    ok: bool
    method: str = "files"
    document_id: str | None = None


class RemarkableSettingsIn(BaseModel):
    host: str = Field(default="", max_length=200)
    user: str = Field(default="root", max_length=80)
    port: int = Field(default=21, ge=1, le=65535)
    folder: str = Field(default="TTM-Todo", max_length=80)
    out_folder: str = Field(default="From TTM-Todo", max_length=80)
    key_path: str = Field(default="", max_length=500)
    private_key: str = Field(default="", max_length=20000)


class GoogleListOut(BaseModel):
    id: str
    title: str
    selected: bool = False


class GoogleKeepConnectIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    master_token: str = Field(min_length=8, max_length=500)


class GoogleTasksListIn(BaseModel):
    list_id: str = Field(min_length=1, max_length=200)


class GoogleKeepListsIn(BaseModel):
    note_ids: list[str] = Field(default_factory=list)
    watch_all: bool = False


class GoogleSourceStatus(BaseModel):
    configured: bool = False
    connected: bool = False
    label: str = ""
    imported: int = 0
    skipped: int = 0
    error: str | None = None
    lists: list[GoogleListOut] = []
    watch_all: bool = False


class GoogleStatusOut(BaseModel):
    tasks: GoogleSourceStatus
    keep: GoogleSourceStatus
    last_at: str | None = None
    last_ok: bool | None = None
    error: str | None = None


class OutlookCalendarOut(BaseModel):
    id: str
    name: str
    selected: bool = False
    color: str = ""


class OutlookAccountOut(BaseModel):
    id: str
    label: str = ""
    error: str | None = None
    calendars: list[OutlookCalendarOut] = []


class OutlookCalendarsIn(BaseModel):
    account_id: str = Field(min_length=1, max_length=320)
    calendar_ids: list[str] = Field(default_factory=list)
    calendar_colors: dict[str, str] | None = None


class OutlookDisconnectIn(BaseModel):
    account_id: str = ""


class OutlookStatusOut(BaseModel):
    configured: bool = False
    connected: bool = False
    accounts: list[OutlookAccountOut] = []


class OutlookEventOut(BaseModel):
    id: str
    calendar_id: str
    calendar_name: str
    color: str = ""
    subject: str = ""
    start: datetime
    end: datetime
    is_all_day: bool = False
    location: str = ""
    web_link: str | None = None


class IcalFeedOut(BaseModel):
    id: str
    label: str = ""
    url: str = ""
    color: str = ""
    error: str | None = None
    last_fetch: float = 0


class IcalStatusOut(BaseModel):
    feeds: list[IcalFeedOut] = []


class IcalFeedIn(BaseModel):
    label: str = Field(default="", max_length=80)
    url: str = Field(min_length=12, max_length=2000)
    color: str = Field(default="", max_length=16)


class IcalFeedPatchIn(BaseModel):
    label: str | None = Field(default=None, max_length=80)
    url: str | None = Field(default=None, max_length=2000)
    color: str | None = Field(default=None, max_length=16)


class CalendarExportStatusOut(BaseModel):
    enabled: bool = False
    path: str | None = None
