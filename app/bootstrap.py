from __future__ import annotations

import json
import logging
import shutil

from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal, engine
from app.models import Base, Bucket, Item, User
from app.security import hash_password
from app.userfiles import google_config_path, google_status_path, remarkable_config_path, remarkable_status_path, user_data_dir
from app.vapid import ensure_vapid_keys

log = logging.getLogger("magictodo")


def migrate_schema() -> None:
    inspector = inspect(engine)
    if "items" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("items")}
    if "parent_id" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE items ADD COLUMN parent_id VARCHAR(36)"))
        log.info("Added items.parent_id")
        columns.add("parent_id")
    if "sort_order" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"))
        log.info("Added items.sort_order")
        _backfill_sort_order()
    if "due_at" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE items ADD COLUMN due_at DATETIME"))
        log.info("Added items.due_at")
        columns.add("due_at")
    if "reminder_lead_minutes" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE items ADD COLUMN reminder_lead_minutes INTEGER"))
        log.info("Added items.reminder_lead_minutes")
        columns.add("reminder_lead_minutes")
    if "remind_at" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE items ADD COLUMN remind_at DATETIME"))
        log.info("Added items.remind_at")
        columns.add("remind_at")
    if "recur_interval" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE items ADD COLUMN recur_interval INTEGER"))
        log.info("Added items.recur_interval")
        columns.add("recur_interval")
    if "recur_unit" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE items ADD COLUMN recur_unit VARCHAR(16)"))
        log.info("Added items.recur_unit")
        columns.add("recur_unit")
    if "plan_task_id" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE items ADD COLUMN plan_task_id VARCHAR(36)"))
        log.info("Added items.plan_task_id")
    _migrate_user_admin()
    _migrate_auth_columns()
    _migrate_bucket_nesting()
    _migrate_template_day_offset()
    _migrate_template_schedule_direction()
    _migrate_department_leads()
    _migrate_plan_task_attachments()
    _migrate_plan_notify_days()
    _migrate_plan_task_notify_days()
    _migrate_invitation_unique()
    _migrate_plan_task_parent()


def _migrate_user_admin() -> None:
    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("users")}
    if "is_admin" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"))
        log.info("Added users.is_admin")
    with SessionLocal() as db:
        admins = db.scalar(select(func.count()).select_from(User).where(User.is_admin.is_(True))) or 0
        if admins:
            return
        first = db.scalars(select(User).order_by(User.created_at.asc())).first()
        if first is None:
            return
        first.is_admin = True
        db.commit()
        log.info("Granted admin to first user %s", first.username)


def _migrate_auth_columns() -> None:
    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("users")}
    with engine.begin() as conn:
        if "email" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR(254)"))
            log.info("Added users.email")
        if "name" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN name VARCHAR(120)"))
            log.info("Added users.name")
        if "auth_provider_id" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN auth_provider_id VARCHAR(128)"))
            log.info("Added users.auth_provider_id")
    with engine.begin() as conn:
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_users_auth_provider_id ON users(auth_provider_id)"))


def _migrate_bucket_nesting() -> None:
    inspector = inspect(engine)
    if "buckets" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("buckets")}
    added = False
    with engine.begin() as conn:
        if "parent_id" not in columns:
            conn.execute(text("ALTER TABLE buckets ADD COLUMN parent_id VARCHAR(36)"))
            log.info("Added buckets.parent_id")
            added = True
        if "organization_id" not in columns:
            conn.execute(text("ALTER TABLE buckets ADD COLUMN organization_id VARCHAR(36)"))
            log.info("Added buckets.organization_id")
            added = True
        if "plan_project_id" not in columns:
            conn.execute(text("ALTER TABLE buckets ADD COLUMN plan_project_id VARCHAR(36)"))
            log.info("Added buckets.plan_project_id")
            added = True
    if added:
        _backfill_plan_bucket_nesting()


def _migrate_template_day_offset() -> None:
    inspector = inspect(engine)
    if "plan_template_tasks" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("plan_template_tasks")}
    with engine.begin() as conn:
        if "day_offset" not in columns:
            conn.execute(text("ALTER TABLE plan_template_tasks ADD COLUMN day_offset INTEGER NOT NULL DEFAULT 0"))
            log.info("Added plan_template_tasks.day_offset")
        conn.execute(
            text(
                "UPDATE plan_template_tasks SET day_offset = week_offset * 7 "
                "WHERE day_offset = 0 AND week_offset > 0"
            )
        )


def _migrate_template_schedule_direction() -> None:
    inspector = inspect(engine)
    if "plan_templates" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("plan_templates")}
    if "schedule_direction" in columns:
        return
    with engine.begin() as conn:
        conn.execute(
            text("ALTER TABLE plan_templates ADD COLUMN schedule_direction VARCHAR(16) NOT NULL DEFAULT 'forward'")
        )
    log.info("Added plan_templates.schedule_direction")


def _migrate_department_leads() -> None:
    inspector = inspect(engine)
    if "department_members" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("department_members")}
    if "is_lead" in columns:
        return
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE department_members ADD COLUMN is_lead BOOLEAN NOT NULL DEFAULT 0"))
    log.info("Added department_members.is_lead")


def _migrate_plan_notify_days() -> None:
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    if "plan_templates" in tables:
        columns = {col["name"] for col in inspector.get_columns("plan_templates")}
        if "notify_days_before" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE plan_templates ADD COLUMN notify_days_before INTEGER"))
            log.info("Added plan_templates.notify_days_before")
    if "plan_projects" in tables:
        columns = {col["name"] for col in inspector.get_columns("plan_projects")}
        if "notify_days_before" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE plan_projects ADD COLUMN notify_days_before INTEGER"))
            log.info("Added plan_projects.notify_days_before")


def _migrate_plan_task_notify_days() -> None:
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    if "plan_template_tasks" in tables:
        columns = {col["name"] for col in inspector.get_columns("plan_template_tasks")}
        if "notify_days_before" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE plan_template_tasks ADD COLUMN notify_days_before INTEGER"))
            log.info("Added plan_template_tasks.notify_days_before")
            if "plan_templates" in tables:
                tmpl_cols = {col["name"] for col in inspector.get_columns("plan_templates")}
                if "notify_days_before" in tmpl_cols:
                    with engine.begin() as conn:
                        conn.execute(
                            text(
                                """
                                UPDATE plan_template_tasks
                                SET notify_days_before = (
                                    SELECT notify_days_before FROM plan_templates
                                    WHERE plan_templates.id = plan_template_tasks.template_id
                                )
                                WHERE notify_days_before IS NULL
                                """
                            )
                        )
    if "plan_tasks" in tables:
        columns = {col["name"] for col in inspector.get_columns("plan_tasks")}
        if "notify_days_before" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE plan_tasks ADD COLUMN notify_days_before INTEGER"))
            log.info("Added plan_tasks.notify_days_before")
            if "plan_projects" in tables:
                proj_cols = {col["name"] for col in inspector.get_columns("plan_projects")}
                if "notify_days_before" in proj_cols:
                    with engine.begin() as conn:
                        conn.execute(
                            text(
                                """
                                UPDATE plan_tasks
                                SET notify_days_before = (
                                    SELECT notify_days_before FROM plan_projects
                                    WHERE plan_projects.id = plan_tasks.project_id
                                )
                                WHERE notify_days_before IS NULL
                                """
                            )
                        )


def _migrate_plan_task_attachments() -> None:
    inspector = inspect(engine)
    if "attachments" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("attachments")}
    if "plan_task_id" in columns:
        return
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE attachments_new (
                    id VARCHAR(36) NOT NULL PRIMARY KEY,
                    item_id VARCHAR(36),
                    plan_task_id VARCHAR(36),
                    original_name VARCHAR(260) NOT NULL,
                    stored_name VARCHAR(80) NOT NULL,
                    mime_type VARCHAR(80) NOT NULL,
                    size INTEGER NOT NULL DEFAULT 0,
                    created_at DATETIME,
                    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
                    FOREIGN KEY(plan_task_id) REFERENCES plan_tasks(id) ON DELETE CASCADE
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO attachments_new
                    (id, item_id, plan_task_id, original_name, stored_name, mime_type, size, created_at)
                SELECT id, item_id, NULL, original_name, stored_name, mime_type, size, created_at
                FROM attachments
                """
            )
        )
        conn.execute(text("DROP TABLE attachments"))
        conn.execute(text("ALTER TABLE attachments_new RENAME TO attachments"))
    log.info("Added attachments.plan_task_id")


def _migrate_invitation_unique() -> None:
    inspector = inspect(engine)
    if "organization_invitations" not in inspector.get_table_names():
        return
    index_names = {idx["name"] for idx in inspector.get_indexes("organization_invitations")}
    if "uq_org_invite_email_pending" in index_names:
        return
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE organization_invitations_new (
                    id VARCHAR(36) NOT NULL PRIMARY KEY,
                    organization_id VARCHAR(36) NOT NULL,
                    email VARCHAR(254) NOT NULL,
                    role VARCHAR(32) NOT NULL,
                    status VARCHAR(32) NOT NULL,
                    invited_by_user_id VARCHAR(36),
                    accepted_user_id VARCHAR(36),
                    created_at DATETIME,
                    accepted_at DATETIME,
                    FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
                    FOREIGN KEY(invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
                    FOREIGN KEY(accepted_user_id) REFERENCES users(id) ON DELETE SET NULL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO organization_invitations_new
                    (id, organization_id, email, role, status, invited_by_user_id,
                     accepted_user_id, created_at, accepted_at)
                SELECT id, organization_id, email, role, status, invited_by_user_id,
                       accepted_user_id, created_at, accepted_at
                FROM organization_invitations
                """
            )
        )
        conn.execute(text("DROP TABLE organization_invitations"))
        conn.execute(text("ALTER TABLE organization_invitations_new RENAME TO organization_invitations"))
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX uq_org_invite_email_pending
                ON organization_invitations(organization_id, email)
                WHERE status = 'pending'
                """
            )
        )
    log.info("Invitation uniqueness is pending-only")


def _migrate_plan_task_parent() -> None:
    inspector = inspect(engine)
    if "plan_tasks" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("plan_tasks")}
    if "parent_id" in columns:
        return
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE plan_tasks ADD COLUMN parent_id VARCHAR(36)"))
    log.info("Added plan_tasks.parent_id")


def _backfill_plan_bucket_nesting() -> None:
    from app.buckets import ensure_org_bucket, ensure_project_bucket
    from app.models import Organization, PlanProject, PlanTask

    inspector = inspect(engine)
    if "plan_tasks" not in inspector.get_table_names():
        return
    with SessionLocal() as db:
        tasks = list(db.scalars(select(PlanTask).where(PlanTask.assignee_user_id.is_not(None))).all())
        if not tasks:
            return
        moved = 0
        for task in tasks:
            if not task.assignee_user_id:
                continue
            project = db.get(PlanProject, task.project_id)
            if project is None:
                continue
            org = db.get(Organization, project.organization_id)
            if org is None:
                continue
            org_bucket = ensure_org_bucket(db, task.assignee_user_id, org)
            item = db.get(Item, task.item_id) if task.item_id else None
            existing = db.get(Bucket, item.bucket_id) if item is not None else None
            if (
                existing is not None
                and not existing.is_inbox
                and existing.id != org_bucket.id
                and existing.plan_project_id in (None, project.id)
                and existing.organization_id is None
            ):
                existing.plan_project_id = project.id
                existing.parent_id = org_bucket.id
                existing.name = (project.name or "Project").strip()[:80] or "Project"
                project_bucket = existing
            else:
                color = existing.color if existing is not None else "#e8a54b"
                project_bucket = ensure_project_bucket(db, task.assignee_user_id, org_bucket, project, color)
            if item is not None and item.bucket_id != project_bucket.id:
                item.bucket_id = project_bucket.id
                moved += 1
        db.commit()
        log.info("Nested plan project buckets (%s assigned tasks, %s items moved)", len(tasks), moved)


def _backfill_sort_order() -> None:
    with SessionLocal() as db:
        rows = list(db.scalars(select(Item)).all())
        groups: dict[tuple[str, str], list[Item]] = {}
        for row in rows:
            key = (row.bucket_id, row.parent_id or "")
            groups.setdefault(key, []).append(row)
        for (bucket_id, parent_id), group in groups.items():
            if parent_id:
                group.sort(key=lambda it: it.created_at)
            else:
                group.sort(key=lambda it: it.created_at, reverse=True)
            for index, item in enumerate(group):
                item.sort_order = index
        db.commit()
    log.info("Backfilled items.sort_order")


def ensure_inbox(db: Session, user: User) -> Bucket:
    inbox = db.scalar(
        select(Bucket).where(Bucket.user_id == user.id, Bucket.is_inbox.is_(True))
    )
    if inbox is None:
        inbox = Bucket(
            user_id=user.id,
            name="Inbox",
            slug="inbox",
            color="#e8a54b",
            sort_order=0,
            is_inbox=True,
        )
        db.add(inbox)
        db.flush()
    return inbox


def _delete_empty_helena_user() -> None:
    from app.orgs import delete_empty_user, user_has_real_data

    with SessionLocal() as db:
        helena = db.scalar(select(User).where(func.lower(User.username) == "helena"))
        if helena is None:
            return
        if helena.auth_provider_id:
            return
        if user_has_real_data(db, helena):
            log.info("Left Helena in place — account has data")
            return
        delete_empty_user(db, helena)
        db.commit()
        log.info("Deleted unused Helena user")


def bootstrap() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    migrate_schema()
    ensure_vapid_keys()
    _delete_empty_helena_user()

    with SessionLocal() as db:
        from app.plan import prune_stale_plan_inbox

        prune_stale_plan_inbox(db)
        db.commit()

    with SessionLocal() as db:
        user_count = db.scalar(select(func.count()).select_from(User)) or 0
        if user_count == 0:
            if settings.auth0_is_enabled:
                log.info("No users yet — sign in with Auth0.")
                return
            if not settings.magictodo_user or not settings.magictodo_password:
                log.info("No users yet — complete setup in the browser.")
                return
            user = User(
                username=settings.magictodo_user.strip(),
                password_hash=hash_password(settings.magictodo_password),
                is_admin=True,
            )
            db.add(user)
            db.flush()
            ensure_inbox(db, user)
            db.commit()
            log.info("Created first user %s", user.username)
            migrate_user_secrets()
            return

        for user in db.scalars(select(User)).all():
            ensure_inbox(db, user)
        db.commit()

    migrate_user_secrets()


def migrate_user_secrets() -> None:
    """Move global Google files and .env reMarkable settings into the admin user's folder."""
    with SessionLocal() as db:
        admin = db.scalar(
            select(User).where(User.is_admin.is_(True)).order_by(User.created_at.asc())
        )
        if admin is None:
            return
        dest_dir = user_data_dir(admin.id)
        _move_if_needed(settings.data_dir / "google.json", google_config_path(admin.id))
        _move_if_needed(settings.data_dir / "google_status.json", google_status_path(admin.id))
        _move_if_needed(settings.data_dir / "remarkable_status.json", remarkable_status_path(admin.id))
        rm_dest = remarkable_config_path(admin.id)
        if not rm_dest.is_file() and settings.remarkable_host.strip():
            key = settings.remarkable_ssh_key
            payload = {
                "host": settings.remarkable_host.strip(),
                "user": settings.remarkable_user,
                "port": settings.remarkable_ssh_port,
                "folder": settings.remarkable_folder,
                "out_folder": settings.remarkable_out_folder,
                "key_path": str(key) if key else "",
            }
            rm_dest.write_text(json.dumps(payload, indent=2))
            rm_dest.chmod(0o600)
            log.info("Migrated .env reMarkable settings into %s", dest_dir)


def _move_if_needed(src, dest) -> None:
    if not src.is_file():
        return
    if dest.is_file():
        src.unlink()
        log.info("Removed leftover global %s (per-user file already exists)", src.name)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))
    try:
        dest.chmod(0o600)
    except OSError:
        pass
    log.info("Moved %s to %s", src.name, dest)
