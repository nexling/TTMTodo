from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    username: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    email: Mapped[str | None] = mapped_column(String(254), unique=True, nullable=True)
    name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    auth_provider_id: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    buckets: Mapped[list[Bucket]] = relationship(back_populates="user")
    items: Mapped[list[Item]] = relationship(back_populates="user")
    tokens: Mapped[list[ApiToken]] = relationship(back_populates="user")
    remarkable_imports: Mapped[list[RemarkableImport]] = relationship(back_populates="user")
    google_imports: Mapped[list[GoogleImport]] = relationship(back_populates="user")
    push_subscriptions: Mapped[list[PushSubscription]] = relationship(back_populates="user")
    memberships: Mapped[list["Membership"]] = relationship(back_populates="user")
    notification_preferences: Mapped[list["UserNotificationPreference"]] = relationship(
        back_populates="user"
    )


class Bucket(Base):
    __tablename__ = "buckets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    color: Mapped[str] = mapped_column(String(16), nullable=False, default="#e8a54b")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_inbox: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("buckets.id", ondelete="SET NULL"), nullable=True, default=None
    )
    organization_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, default=None
    )
    plan_project_id: Mapped[str | None] = mapped_column(
        ForeignKey("plan_projects.id", ondelete="SET NULL"), nullable=True, default=None
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    user: Mapped[User] = relationship(back_populates="buckets")
    items: Mapped[list[Item]] = relationship(back_populates="bucket", passive_deletes=True)


class Item(Base):
    __tablename__ = "items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    bucket_id: Mapped[str] = mapped_column(ForeignKey("buckets.id", ondelete="RESTRICT"), nullable=False)
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="web")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reminder_lead_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    remind_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    recur_interval: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recur_unit: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ocr_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_priority: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    user: Mapped[User] = relationship(back_populates="items")
    bucket: Mapped[Bucket] = relationship(back_populates="items")
    attachments: Mapped[list[Attachment]] = relationship(
        back_populates="item",
        cascade="all, delete-orphan",
        foreign_keys="Attachment.item_id",
    )
    push_deliveries: Mapped[list[PushDelivery]] = relationship(
        back_populates="item", cascade="all, delete-orphan"
    )
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), nullable=True, default=None
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    plan_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="SET NULL"), nullable=True, unique=True, default=None
    )


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    item_id: Mapped[str | None] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), nullable=True, default=None
    )
    plan_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"), nullable=True, default=None
    )
    original_name: Mapped[str] = mapped_column(String(260), nullable=False, default="image")
    stored_name: Mapped[str] = mapped_column(String(80), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(80), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    item: Mapped[Item | None] = relationship(back_populates="attachments", foreign_keys=[item_id])
    plan_task: Mapped[PlanTask | None] = relationship(
        back_populates="attachments", foreign_keys=[plan_task_id]
    )


class ApiToken(Base):
    __tablename__ = "api_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped[User] = relationship(back_populates="tokens")


class RemarkableImport(Base):
    __tablename__ = "remarkable_imports"
    __table_args__ = (
        UniqueConstraint("user_id", "doc_uuid", "page_id", name="uq_rm_import_page"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    doc_uuid: Mapped[str] = mapped_column(String(36), nullable=False)
    page_id: Mapped[str] = mapped_column(String(36), nullable=False)
    page_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    item_id: Mapped[str | None] = mapped_column(
        ForeignKey("items.id", ondelete="SET NULL"), nullable=True, default=None
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)

    user: Mapped[User] = relationship(back_populates="remarkable_imports")


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    p256dh: Mapped[str] = mapped_column(String(200), nullable=False)
    auth: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    user: Mapped[User] = relationship(back_populates="push_subscriptions")


class PushDelivery(Base):
    __tablename__ = "push_deliveries"
    __table_args__ = (
        UniqueConstraint("item_id", "kind", "fire_at", name="uq_push_delivery"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    fire_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    item: Mapped[Item] = relationship(back_populates="push_deliveries")


class GoogleImport(Base):
    __tablename__ = "google_imports"
    __table_args__ = (
        UniqueConstraint("user_id", "provider", "remote_id", name="uq_google_import"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    remote_id: Mapped[str] = mapped_column(String(160), nullable=False)
    item_id: Mapped[str | None] = mapped_column(
        ForeignKey("items.id", ondelete="SET NULL"), nullable=True, default=None
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    user: Mapped[User] = relationship(back_populates="google_imports")


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    owner: Mapped[User | None] = relationship(foreign_keys=[owner_user_id])
    memberships: Mapped[list["Membership"]] = relationship(back_populates="organization")
    invitations: Mapped[list["OrganizationInvitation"]] = relationship(back_populates="organization")
    licenses: Mapped[list["LicenseAssignment"]] = relationship(back_populates="organization")


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "organization_id", name="uq_membership_user_org"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="user")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    user: Mapped[User] = relationship(back_populates="memberships")
    organization: Mapped[Organization] = relationship(back_populates="memberships")


class OrganizationInvitation(Base):
    __tablename__ = "organization_invitations"
    __table_args__ = (
        Index(
            "uq_org_invite_email_pending",
            "organization_id",
            "email",
            unique=True,
            sqlite_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(254), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="user")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    invited_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    accepted_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    organization: Mapped[Organization] = relationship(back_populates="invitations")


class LicenseAssignment(Base):
    __tablename__ = "license_assignments"
    __table_args__ = (
        UniqueConstraint("license_type", "organization_id", name="uq_license_type_organization"),
        UniqueConstraint("license_type", "user_id", name="uq_license_type_user"),
        UniqueConstraint("license_type", "assigned_email", name="uq_license_type_email"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    license_type: Mapped[str] = mapped_column(String(32), nullable=False)
    organization_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    assigned_email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    seat_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    organization: Mapped[Organization | None] = relationship(back_populates="licenses")
    user: Mapped[User | None] = relationship(foreign_keys=[user_id])


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    color: Mapped[str] = mapped_column(String(16), nullable=False, default="#7c9a6d")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    organization: Mapped[Organization] = relationship()
    members: Mapped[list["DepartmentMember"]] = relationship(
        back_populates="department", cascade="all, delete-orphan"
    )


class DepartmentMember(Base):
    __tablename__ = "department_members"
    __table_args__ = (UniqueConstraint("department_id", "user_id", name="uq_department_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    department_id: Mapped[str] = mapped_column(
        ForeignKey("departments.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    is_lead: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    department: Mapped[Department] = relationship(back_populates="members")
    user: Mapped[User] = relationship()


class PlanTemplate(Base):
    __tablename__ = "plan_templates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    schedule_direction: Mapped[str] = mapped_column(String(16), nullable=False, default="forward")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    tasks: Mapped[list["PlanTemplateTask"]] = relationship(
        back_populates="template", cascade="all, delete-orphan"
    )


class PlanTemplateTask(Base):
    __tablename__ = "plan_template_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    template_id: Mapped[str] = mapped_column(
        ForeignKey("plan_templates.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    department_id: Mapped[str | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    week_offset: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    day_offset: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    notify_days_before: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    template: Mapped[PlanTemplate] = relationship(back_populates="tasks")
    successors: Mapped[list["PlanTemplateDep"]] = relationship(
        back_populates="predecessor",
        foreign_keys="PlanTemplateDep.predecessor_id",
        cascade="all, delete-orphan",
    )


class PlanTemplateDep(Base):
    __tablename__ = "plan_template_deps"
    __table_args__ = (
        UniqueConstraint("predecessor_id", "successor_id", name="uq_plan_template_dep"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    predecessor_id: Mapped[str] = mapped_column(
        ForeignKey("plan_template_tasks.id", ondelete="CASCADE"), nullable=False
    )
    successor_id: Mapped[str] = mapped_column(
        ForeignKey("plan_template_tasks.id", ondelete="CASCADE"), nullable=False
    )

    predecessor: Mapped[PlanTemplateTask] = relationship(
        foreign_keys=[predecessor_id], back_populates="successors"
    )
    successor: Mapped[PlanTemplateTask] = relationship(foreign_keys=[successor_id])


class PlanProject(Base):
    __tablename__ = "plan_projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    tasks: Mapped[list["PlanTask"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class PlanTask(Base):
    __tablename__ = "plan_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("plan_projects.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    department_id: Mapped[str | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    assignee_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    notify_days_before: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    item_id: Mapped[str | None] = mapped_column(String(36), nullable=True, default=None)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"), nullable=True, default=None
    )

    project: Mapped[PlanProject] = relationship(back_populates="tasks")
    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_user_id])
    attachments: Mapped[list["Attachment"]] = relationship(
        back_populates="plan_task",
        cascade="all, delete-orphan",
        foreign_keys="Attachment.plan_task_id",
    )
    mail_deliveries: Mapped[list["PlanTaskMailDelivery"]] = relationship(
        back_populates="plan_task", cascade="all, delete-orphan"
    )


class PlanTaskDep(Base):
    __tablename__ = "plan_task_deps"
    __table_args__ = (UniqueConstraint("predecessor_id", "successor_id", name="uq_plan_task_dep"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    predecessor_id: Mapped[str] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"), nullable=False
    )
    successor_id: Mapped[str] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"), nullable=False
    )


class PlanTaskMailDelivery(Base):
    __tablename__ = "plan_task_mail_deliveries"
    __table_args__ = (UniqueConstraint("plan_task_id", "due_on", name="uq_plan_task_mail_delivery"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    plan_task_id: Mapped[str] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"), nullable=False
    )
    due_on: Mapped[date] = mapped_column(Date, nullable=False)
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    plan_task: Mapped[PlanTask] = relationship(back_populates="mail_deliveries")


class UserNotificationPreference(Base):
    __tablename__ = "user_notification_preferences"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "category", "project_id", name="uq_notify_pref_project"
        ),
        Index(
            "uq_notify_pref_global",
            "user_id",
            "category",
            unique=True,
            sqlite_where=text("project_id IS NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("plan_projects.id", ondelete="CASCADE"), nullable=True, default=None
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    user: Mapped[User] = relationship(back_populates="notification_preferences")
    project: Mapped[PlanProject | None] = relationship(foreign_keys=[project_id])
