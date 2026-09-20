from __future__ import annotations

import html
import logging
import smtplib
from collections import defaultdict
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.config import ROOT_DIR, settings
from app.database import SessionLocal
from app.models import Department, DepartmentMember, PlanProject, PlanTask, PlanTaskMailDelivery, User

log = logging.getLogger("magictodo")

_logged_missing_smtp = False


def mail_today() -> date:
    try:
        tz = ZoneInfo(settings.mail_timezone.strip() or "Europe/Stockholm")
    except ZoneInfoNotFoundError:
        log.warning("Unknown MAIL_TIMEZONE %s; using UTC", settings.mail_timezone)
        tz = ZoneInfo("UTC")
    return datetime.now(tz).date()


def smtp_configured() -> bool:
    global _logged_missing_smtp
    if settings.smtp_host.strip():
        return True
    if not _logged_missing_smtp:
        log.info("SMTP_HOST is empty; plan due emails are skipped")
        _logged_missing_smtp = True
    return False


def _from_addr() -> str:
    return (settings.smtp_from or settings.smtp_user).strip() or "todo@localhost"


def _public_url() -> str:
    return settings.public_url.strip().rstrip("/")


def send_email_result(to: str, subject: str, text: str, html_body: str) -> tuple[bool, str | None]:
    if not smtp_configured():
        return False, "SMTP is not configured. Set SMTP_HOST on the server."
    dest = to.strip()
    if not dest:
        return False, "Enter an email address."
    if "@" not in dest or dest.startswith("@") or dest.endswith("@"):
        return False, "Enter a valid email address."
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = _from_addr()
    msg["To"] = dest
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")
    host = settings.smtp_host.strip()
    port = settings.smtp_port
    try:
        if settings.smtp_ssl:
            client: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=20)
        else:
            client = smtplib.SMTP(host, port, timeout=20)
        with client:
            if settings.smtp_starttls and not settings.smtp_ssl:
                client.starttls()
            user = settings.smtp_user.strip()
            if user:
                client.login(user, settings.smtp_password)
            client.send_message(msg)
        return True, None
    except Exception as exc:
        log.exception("SMTP send failed to %s", dest)
        return False, str(exc) or "SMTP send failed"


def send_email(to: str, subject: str, text: str, html_body: str) -> bool:
    ok, _err = send_email_result(to, subject, text, html_body)
    return ok


def send_test_mail(to: str) -> tuple[bool, str | None, str]:
    dest = to.strip()
    origin = _public_url() or "TTM-Todo"
    subject = "TTM-Todo test email"
    text = (
        "This is a test message from TTM-Todo.\n"
        "If you received it, SMTP is working.\n"
        f"{origin}\n"
    )
    html_body = (
        "<p>This is a test message from TTM-Todo.</p>"
        "<p>If you received it, SMTP is working.</p>"
        f"<p>{html.escape(origin)}</p>"
    )
    ok, err = send_email_result(dest, subject, text, html_body)
    return ok, err, dest


HELP_SCREENSHOTS = (
    ("01-open-site.png", "TTM-Todo sign-in page with Sign in visible"),
    ("02-auth0-signup.png", "Auth0 login with Sign up highlighted"),
    ("03-auth0-create.png", "Auth0 create-account form"),
)


def _help_image_path(filename: str) -> Path | None:
    for folder in (ROOT_DIR / "web" / "dist" / "help", ROOT_DIR / "web" / "public" / "help"):
        candidate = folder / filename
        if candidate.is_file():
            return candidate
    return None


def _help_image_html(origin: str) -> str:
    if not origin:
        return ""
    chunks: list[str] = []
    for filename, alt in HELP_SCREENSHOTS:
        if _help_image_path(filename) is None:
            continue
        src = f"{html.escape(origin)}/help/{html.escape(filename)}"
        chunks.append(
            f'<p><img src="{src}" alt="{html.escape(alt)}" width="480" '
            'style="max-width:100%;height:auto;border-radius:8px;"></p>'
        )
    return "".join(chunks)


def send_assignment_email(
    to: str,
    *,
    assigner: str,
    title: str,
    project_name: str,
    project_id: str,
) -> tuple[bool, str | None]:
    dest = to.strip()
    url = _project_url(project_id)
    subject = f"{title} assigned to you — {project_name}"
    who = assigner.strip() or "Someone"
    text = (
        f"{who} assigned you “{title}” in {project_name}.\n\n"
        f"{url}\n"
    )
    html_body = (
        f"<p>{html.escape(who)} assigned you "
        f"<strong>{html.escape(title)}</strong> in {html.escape(project_name)}.</p>"
        f'<p><a href="{html.escape(url, quote=True)}">Open the project</a></p>'
    )
    return send_email_result(dest, subject, text, html_body)


def send_invite_email(
    to: str,
    *,
    org_name: str | None = None,
    existing_user: bool = False,
) -> tuple[bool, str | None]:
    dest = to.strip()
    origin = _public_url() or "https://todo.takttimemodular.com"
    login_url = f"{origin}/login"
    signup_url = f"{origin}/login?signup=1"
    org = (org_name or "").strip()
    if org:
        subject = f"You're invited to {org} on TTM-Todo"
        where = f"the organization {org} on TTM-Todo"
    else:
        subject = "You're invited to TTM-Todo"
        where = "TTM-Todo"

    if existing_user:
        text = (
            f"You have been added to {where}.\n\n"
            "Sign in with your existing Auth0 account:\n"
            f"{login_url}\n"
        )
        html_body = (
            f"<p>You have been added to {html.escape(where)}.</p>"
            "<p>Sign in with your existing Auth0 account:</p>"
            f'<p><a href="{html.escape(login_url)}">Sign in to TTM-Todo</a></p>'
        )
    else:
        text = (
            f"You have been invited to {where}.\n\n"
            "Create an Auth0-TTM account with this same email address, then you can open TTM-Todo.\n\n"
            "1. Open this link and choose Sign up:\n"
            f"   {signup_url}\n"
            "2. Use the email address this message was sent to.\n"
            "3. After you create the account, Auth0 returns you to TTM-Todo.\n"
            "   Your invitation and any license are attached automatically.\n\n"
            f"If you already have an TTM account for this email, sign in instead:\n{login_url}\n"
        )
        shots = _help_image_html(origin)
        html_body = (
            f"<p>You have been invited to {html.escape(where)}.</p>"
            "<p>Create an Auth0 account with <strong>this same email address</strong>, "
            "then you can open TTM-Todo.</p>"
            "<ol>"
            f'<li>Open <a href="{html.escape(signup_url)}">TTM-Todo and choose Sign up</a>.</li>'
            "<li>Use the email address this message was sent to.</li>"
            "<li>After you create the account, Auth0 returns you to TTM-Todo. "
            "Your invitation and any license are attached automatically.</li>"
            "</ol>"
            f"{shots}"
            f'<p>If you already have an TTM account for this email, '
            f'<a href="{html.escape(login_url)}">sign in here</a>.</p>'
        )
    return send_email_result(dest, subject, text, html_body)


def _already_sent(db: Session, task_id: str, due_on: date) -> bool:
    return (
        db.scalar(
            select(PlanTaskMailDelivery.id).where(
                PlanTaskMailDelivery.plan_task_id == task_id,
                PlanTaskMailDelivery.due_on == due_on,
            )
        )
        is not None
    )


def _record_deliveries(db: Session, keys: set[tuple[str, date]]) -> None:
    for task_id, due_on in keys:
        if _already_sent(db, task_id, due_on):
            continue
        db.add(PlanTaskMailDelivery(plan_task_id=task_id, due_on=due_on))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()


def _user_email(user: User | None) -> str | None:
    if user is None:
        return None
    email = (user.email or "").strip()
    return email or None


def recipients_for_task(db: Session, task: PlanTask) -> list[User]:
    if task.assignee_user_id:
        person = task.assignee if task.assignee is not None else db.get(User, task.assignee_user_id)
        return [person] if person is not None and _user_email(person) else []
    if not task.department_id:
        return []
    return list(
        db.scalars(
            select(User)
            .join(DepartmentMember, DepartmentMember.user_id == User.id)
            .where(
                DepartmentMember.department_id == task.department_id,
                DepartmentMember.is_lead.is_(True),
            )
        ).all()
    )


def _due_phrase(due: date, today: date) -> str:
    delta = (due - today).days
    if delta < 0:
        n = -delta
        return f"overdue by {n} day" if n == 1 else f"overdue by {n} days"
    if delta == 0:
        return "due today"
    if delta == 1:
        return "due tomorrow"
    return f"due in {delta} days"


def _project_url(project_id: str) -> str:
    base = _public_url()
    path = f"/org/projects/{project_id}"
    return f"{base}{path}" if base else path


def _digest_subject(rows: list[tuple[PlanTask, PlanProject, str]]) -> str:
    if len(rows) == 1:
        task, project, _dept = rows[0]
        title = (task.title or "").strip() or "Untitled"
        return f"{title} due {task.week_start.isoformat()} — {project.name}"
    projects = {project.id for _task, project, _dept in rows}
    if len(projects) == 1:
        return f"{len(rows)} tasks due soon — {rows[0][1].name}"
    return f"{len(rows)} tasks due soon"


def _digest_bodies(rows: list[tuple[PlanTask, PlanProject, str]], today: date) -> tuple[str, str]:
    grouped: dict[str, list[tuple[PlanTask, PlanProject, str]]] = defaultdict(list)
    order: list[str] = []
    for row in rows:
        project_id = row[1].id
        if project_id not in grouped:
            order.append(project_id)
        grouped[project_id].append(row)

    text_parts = ["These plan tasks need attention:", ""]
    html_parts = ["<p>These plan tasks need attention:</p>"]
    for project_id in order:
        items = grouped[project_id]
        project = items[0][1]
        url = _project_url(project.id)
        text_parts.append(f"{project.name}")
        html_parts.append(f"<h3>{html.escape(project.name)}</h3><ul>")
        for task, _project, dept_name in items:
            title = (task.title or "").strip() or "Untitled"
            due = task.week_start.isoformat()
            phrase = _due_phrase(task.week_start, today)
            dept = f" ({dept_name})" if dept_name else ""
            text_parts.append(f"- {title} — {due}{dept} · {phrase}")
            text_parts.append(f"  {url}")
            html_parts.append(
                "<li>"
                f'<a href="{html.escape(url, quote=True)}">{html.escape(title)}</a>'
                f" — {html.escape(due)}{html.escape(dept)} · {html.escape(phrase)}"
                "</li>"
            )
        html_parts.append("</ul>")
        text_parts.append("")
    return "\n".join(text_parts).strip() + "\n", "\n".join(html_parts)


def dispatch_plan_due_mail(
    db: Session,
    *,
    project_id: str | None = None,
    task_id: str | None = None,
    today: date | None = None,
) -> dict[str, int]:
    day = today or mail_today()
    query = (
        select(PlanTask)
        .join(PlanProject, PlanProject.id == PlanTask.project_id)
        .options(selectinload(PlanTask.project), selectinload(PlanTask.assignee))
        .where(PlanTask.status == "open", PlanTask.notify_days_before.is_not(None))
        .order_by(PlanTask.week_start, PlanTask.sort_order, PlanTask.title)
    )
    if project_id:
        query = query.where(PlanTask.project_id == project_id)
    if task_id:
        query = query.where(PlanTask.id == task_id)
    tasks = list(db.scalars(query).all())
    dept_ids = {task.department_id for task in tasks if task.department_id}
    departments = {
        dept.id: dept
        for dept in db.scalars(select(Department).where(Department.id.in_(dept_ids))).all()
    } if dept_ids else {}

    by_user: dict[str, list[tuple[PlanTask, PlanProject, str]]] = defaultdict(list)
    users: dict[str, User] = {}
    considered = 0
    skipped = 0
    from app.notifications import CATEGORY_PLAN_DUE, allowed as notify_allowed

    for task in tasks:
        project = task.project
        days = task.notify_days_before
        if days is None:
            continue
        if task.week_start > day + timedelta(days=days):
            continue
        considered += 1
        if _already_sent(db, task.id, task.week_start):
            skipped += 1
            continue
        people = [
            user
            for user in recipients_for_task(db, task)
            if _user_email(user) and notify_allowed(db, user.id, CATEGORY_PLAN_DUE, task.project_id)
        ]
        if not people:
            skipped += 1
            continue
        dept_name = departments[task.department_id].name if task.department_id and task.department_id in departments else ""
        for user in people:
            users[user.id] = user
            by_user[user.id].append((task, project, dept_name))

    if not by_user:
        return {"sent": 0, "skipped": skipped, "tasks": considered}

    if not smtp_configured():
        return {"sent": 0, "skipped": skipped + sum(len(rows) for rows in by_user.values()), "tasks": considered}

    sent = 0
    recorded: set[tuple[str, date]] = set()
    for user_id, rows in by_user.items():
        user = users[user_id]
        email = _user_email(user)
        if email is None:
            skipped += len(rows)
            continue
        subject = _digest_subject(rows)
        text, html_body = _digest_bodies(rows, day)
        if send_email(email, subject, text, html_body):
            sent += 1
            for task, _project, _dept in rows:
                recorded.add((task.id, task.week_start))
        else:
            skipped += len(rows)

    if recorded:
        _record_deliveries(db, recorded)
    return {"sent": sent, "skipped": skipped, "tasks": considered}


def cli_dispatch() -> int:
    from app.bootstrap import bootstrap

    logging.basicConfig(level=logging.INFO)
    bootstrap()
    with SessionLocal() as db:
        result = dispatch_plan_due_mail(db)
    print("mail sent={sent} skipped={skipped} tasks={tasks}".format(**result))
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_dispatch())
