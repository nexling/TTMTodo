# TTM-Todo

Personal inbox for todos and pictures. Items land in **Inbox**, then you sort them into buckets. Designed to live at `todo.takttimemodular.com` behind the nginx instance that already serves TTMFlow.

## What v1 does

- Sign-in with Auth0
- Dump text, a photo, or both
- Photo-only items (the picture is the todo)
- Buckets, check-off, show/hide completed
- Installable PWA + Android Share Target
- Capture API: `POST /api/inbox` with a bearer token
- Siri via an iOS Shortcut that POSTs into the Capture API
- Google Home voice via polling Google Tasks and Google Keep
- Calendar page (due dates + optional Outlook / ICS overlay)
- Subscribe TTM-Todo due dates into Outlook via a secret ICS feed (no file download)

Not in v1: email-to-inbox, local OCR/LLM.

## Local / this machine

```bash
cd /mnt/Websites/MagicTODO
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # set a long SECRET_KEY
.venv/bin/python scripts/generate_icons.py
cd web && npm install && npm run build && cd ..
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8010
```

Open `http://127.0.0.1:8010`. With Auth0 configured, you are redirected to sign in. Without Auth0, complete setup then Settings → create a capture token.

### Auth0

Create a **Regular Web Application** (not SPA). Put the client id/secret in `.env` (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `SITE_ADMIN_EMAILS`). Allowed callback URLs: `https://todo.takttimemodular.com/callback` and `http://127.0.0.1:8010/callback`. Logout return to `/`.

Site admins (emails in `SITE_ADMIN_EMAILS`) assign individual or organization seat licenses at `/website-admin`. Unlicensed users see a blocked page. Everyone keeps a private inbox; organizations are for membership and licensing only.

Without Auth0, password `/setup` and `/login` remain for a local first account.

Org admins invite or remove members in Settings. More roles can be added later; this version is site admin, org owner/admin, and member.

## Tailscale (works now, before public HTTPS)

The app stays on `127.0.0.1:8010`. A small proxy listens **only** on the Tailscale IP (`100.108.52.61`), not on the public internet:

**http://nexserve.tail18d09c.ts.net:8010**

Phone and other tailnet devices (Tailscale connected) can use that URL. systemd user unit: `magictodo-tailscale`.

### HTTPS on the tailnet (PWA / camera / Share Target)

Tailscale Serve gives `https://nexserve.tail18d09c.ts.net` without opening a public port. This tailnet still has Serve **off**. Enable it once (you are the owner), then run the helper:

1. Open https://login.tailscale.com/f/serve?node=njmXGTHDHM11CNTRL and allow Serve.
2. `bash /mnt/Websites/MagicTODO/scripts/enable-tailscale-serve.sh`
3. Set `PUBLIC_URL=https://nexserve.tail18d09c.ts.net` in `.env` and `systemctl --user restart magictodo`.

Serve intercepts only Tailscale HTTPS on **8443** so public `:443` stays TTMFlow nginx. Funnel stays off.

If Serve is still on 443 it will fight TTMFlow nginx. Use `--https=8443` (`https://nexserve.tail18d09c.ts.net:8443`).

Dev UI with hot reload: run uvicorn as above, then `cd web && npm run dev` (proxies `/api` to :8010).

## systemd

A **user** unit is the default (no root). It binds `127.0.0.1:8010`:

```bash
mkdir -p ~/.config/systemd/user
cp /mnt/Websites/MagicTODO/deploy/magictodo.user.service ~/.config/systemd/user/magictodo.service
systemctl --user daemon-reload
systemctl --user enable --now magictodo
systemctl --user status magictodo
# persist after logout / reboot:
sudo loginctl enable-linger "$USER"
```

System-wide alternative (needs sudo):

```bash
sudo cp /mnt/Websites/MagicTODO/deploy/magictodo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now magictodo
```

After HTTPS is live on the public domain, `SESSION_HTTPS_ONLY=true` is already the default for this host. Cookies are Secure on HTTPS and still work on `http://127.0.0.1:8010`.

## Public hostname

TTMFlow’s project nginx owns ports 80/443 (`ttmflow-nginx.service`). System nginx is disabled. The Let’s Encrypt wildcard `*.takttimemodular.com` (live name `flow.takttimemodular.com`) covers both Flow and Todo.

One-time cutover (asks for your sudo password):

```bash
bash /mnt/Websites/MagicTODO/scripts/enable-ttmflow-nginx.sh
```

That disables system nginx, moves Tailscale Serve to `:8443`, and enables `ttmflow-nginx` on boot.

1. DNS: `todo.takttimemodular.com` CNAME → `todotakttimemodular.freemyip.com` (or an A record to the same public IP as Flow).
2. Vhost: [`deploy/nginx-todo.conf`](deploy/nginx-todo.conf) is included from [`/mnt/Websites/TTMFlow/ifc-pipeline/nginx/conf/nginx.conf`](/mnt/Websites/TTMFlow/ifc-pipeline/nginx/conf/nginx.conf). Leave the Flow `server { }` blocks unchanged.
3. App: `PUBLIC_URL=https://todo.takttimemodular.com` and `SESSION_HTTPS_ONLY=true` are already set. Register `https://todo.takttimemodular.com/api/google/callback` on the NexApp Web client.

If a browser shows a **Ubiquiti** certificate on `todo.takttimemodular.com`, WAN `:443` is still the router UI. Forward TCP 80 and 443 to this machine and move the UniFi web UI off 443.

## Capture API

```
POST /api/inbox
Authorization: Bearer mt_...
```

JSON (Siri Shortcuts):

```
Content-Type: application/json

{"text": "Buy milk", "source": "siri"}
```

Multipart (curl, Tasker, photos):

```
Content-Type: multipart/form-data
  text: optional
  image: optional file (jpeg/png/webp/gif, max 32 MB)
  source: optional label (default api)
```

At least one of `text` or `image` is required (`image` is multipart only). Always creates an Inbox item. First line of `text` becomes the title; the rest becomes notes.

## Siri (Shortcuts)

Siri has no public Reminders API to poll the way Google Tasks/Keep work. Speak into an iOS Shortcut that POSTs to `/api/inbox`. Items land in Inbox immediately, tagged `siri`.

Phrase: `Hey Siri, Add to TTM-Todo`

1. Settings → Capture tokens → create a token named **Siri**. Copy it when it is shown (once only).
2. On iPhone/iPad, Shortcuts → New Shortcut. Name it **Add to TTM-Todo**.
3. Add **Ask for Input** (Text), prompt `What should I add?`
4. Add **Get Contents of URL**:
   - URL: `https://todo.takttimemodular.com/api/inbox`
   - Method: POST
   - Headers: `Authorization: Bearer mt_...` and `Content-Type: application/json`
   - Request Body: JSON with `text` = Ask for Input result and `source` = `siri`
5. Turn **Show When Run** off so HomePod can run the same iCloud-synced shortcut.

Settings shows copyable URL, headers, and a JSON example. One-shot “add milk to TTM-Todo” without a follow-up question needs a native iOS app (out of scope).

## Google voice (Tasks + Keep)

Google Assistant will not POST spoken text to this app. Speak into a list Google actually writes, then a timer on NEXSERVE pulls new rows into Inbox.

**Tasks (stable):** `Hey Google, add buy milk to my TTM-Todo list`

1. Enable the **Google Tasks API** in Google Cloud.
2. OAuth client must be type **Web application** (NexApp). Authorized redirect URI — loopback only, not Tailscale `http://`:
   - `http://127.0.0.1:8010/api/google/callback`
   - Later, if Tailscale Serve HTTPS is on: `https://nexserve.tail18d09c.ts.net/api/google/callback`
3. Consent screen: External + Testing, add your Gmail as a test user.
4. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, restart `magictodo`.
5. From Windows, tunnel then open Settings on loopback (same host as the redirect, or the session cookie is lost):

```bash
ssh -L 8010:127.0.0.1:8010 nexserve
```

Open **http://127.0.0.1:8010/settings** → **Connect Tasks**. Incomplete items on **every** Tasks list are imported. Do not click Connect from `http://nexserve.tail18d09c.ts.net:8010` — Google returns Error 400: invalid_request.

**Keep (shopping lists / notes-and-lists):** `Hey Google, add milk to my shopping list`

The official Keep API is Workspace-only. TTM-Todo uses [gkeepapi](https://github.com/kiwiz/gkeepapi) with your Gmail and a master token (not the Cloud OAuth client). Connect Keep in Settings; default watch lists are **Shopping list**, **TTM-Todo**, and **MagicTODO**. This protocol can break; Tasks still works.

Mint a master token (do not put it in `.env` or git):

1. Sign in at [https://accounts.google.com/EmbeddedSetup](https://accounts.google.com/EmbeddedSetup). A spinner hang is normal.
2. DevTools → Application → Cookies → copy `oauth_token`.
3. On NEXSERVE:

```bash
cd /mnt/Websites/MagicTODO
.venv/bin/python scripts/google_keep_master_token.py
```

4. Paste the printed Token into Settings → Connect Keep.

Poller (user systemd):

```bash
cp /mnt/Websites/MagicTODO/deploy/magictodo-google.user.service ~/.config/systemd/user/magictodo-google.service
cp /mnt/Websites/MagicTODO/deploy/magictodo-google.timer ~/.config/systemd/user/magictodo-google.timer
systemctl --user daemon-reload
systemctl --user enable --now magictodo-google.timer
```

Imported cards are tagged `google-tasks` or `google-keep`. A ledger prevents duplicates. Disconnecting one source leaves the other running.

## Outlook calendar (read-only)

The **Calendar** page shows TTM-Todo due dates as 30-minute blocks (Day / 3 days / Work week / Week / Month). Outlook events can overlay that grid after you connect Microsoft Graph.

1. In [Microsoft Entra](https://entra.microsoft.com/) register an app: accounts in any org and personal Microsoft accounts.
2. Add a **Web** redirect URI:
   - `http://127.0.0.1:8010/api/outlook/callback`
   - Your HTTPS origin, e.g. `https://todo.takttimemodular.com/api/outlook/callback`
3. Delegated permissions: **Calendars.Read**, **User.Read**, **offline_access**.
4. Put `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in `.env` (`MICROSOFT_TENANT=common`), restart `magictodo`.
5. Settings → **Connect Outlook** or **Add Outlook account**, then pick calendars on each mailbox. You can connect work and personal Microsoft accounts; reconnecting the same email refreshes that mailbox instead of duplicating it.

Tokens are stored per user in `data/users/{id}/outlook.json`. Connecting Outlook does **not** copy TTM-Todo tasks into Microsoft calendars.

## Show tasks in Outlook (subscribe)

To see TTM-Todo due dates **in Outlook**, subscribe to a live ICS feed. There is no `.ics` file download.

1. Settings → **Show tasks in Outlook** → Enable subscribe URL.
2. Copy the secret URL. Treat it like a password.
3. Outlook on the web: **Add calendar → Subscribe from web**, paste the URL.
4. Outlook desktop: **Add Calendar → From Internet**, paste the URL.

Outlook refreshes the feed as open tasks with due dates change. Regenerating the URL invalidates the old one. Outlook on the web can only fetch the feed if this site is reachable over HTTPS. The token is stored per user in `data/users/{id}/calendar_export.json`.

## Calendar subscription (ICS)

If IT blocks Entra consent, publish a calendar instead and paste the secret ICS URL in Settings → **Calendar subscription (ICS)**.

1. Outlook on the web: **Settings → Calendar → Shared calendars → Publish a calendar**.
2. Copy the ICS link (private feed). Treat it like a password.
3. Paste it in TTM-Todo Settings. Optional label and color. Google Calendar and other HTTPS `.ics` feeds work the same way.

Feeds are stored per user in `data/users/{id}/ical.json`. TTM-Todo fetches each feed when you open the Calendar (cached about 15 minutes). Events are read-only overlays, same as Graph Outlook.

## Android PWA

Chrome → Add to Home screen. Stay signed in. Share a photo or text from another app → TTM-Todo. Shared items go to Inbox (`source=share`).

## Layout

- `app/` FastAPI, SQLite at `data/magictodo.db`, uploads in `data/uploads/`
- `web/` Vite React PWA
- `deploy/` systemd units + nginx snippet
- `scripts/tailscale_proxy.py` Tailscale-IP-only proxy
- `scripts/enable-tailscale-serve.sh` Serve HTTPS helper
- `scripts/google_keep_master_token.py` exchange EmbeddedSetup cookie for a Keep master token
