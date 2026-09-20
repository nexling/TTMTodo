import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, mailFailureHint, type ApiToken, type Bucket, type CalendarExportStatus, type GoogleStatus, type IcalStatus, type Invitation, type Membership, type NotificationPreferences, type OrgSettings, type OutlookStatus, type RemarkableStatus } from "../api";
import { walkBucketTree } from "../bucketTree";
import { roleLabel } from "../roles";
import ColorPicker, { COLOR_PALETTE } from "../components/ColorPicker";
import SidebarResizeHandle from "../components/SidebarResizeHandle";
import TestMailBox from "../components/TestMailBox";
import {
  readInboxCompact,
  readInboxCompactNotes,
  writeInboxCompact,
  writeInboxCompactNotes,
} from "../inboxPrefs";
import {
  hasPushSubscription,
  isAndroidDevice,
  isIosDevice,
  isStandalonePwa,
  pushSupported,
  subscribePush,
  unsubscribePush,
} from "../push";

type Props = {
  username: string;
  isSiteAdmin?: boolean;
  userEmail?: string;
  publicUrl?: string;
  organizationName?: string;
  onLogout: () => Promise<void> | void;
};

export default function Settings({ username, isSiteAdmin, userEmail, publicUrl, organizationName }: Props) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [err, setErr] = useState("");
  const [rm, setRm] = useState<RemarkableStatus | null>(null);
  const [rmBusy, setRmBusy] = useState(false);
  const [rmErr, setRmErr] = useState("");
  const [rmMsg, setRmMsg] = useState("");
  const [rmHost, setRmHost] = useState("");
  const [rmUser, setRmUser] = useState("root");
  const [rmPort, setRmPort] = useState("21");
  const [rmFolder, setRmFolder] = useState("TTM-Todo");
  const [rmOutFolder, setRmOutFolder] = useState("From TTM-Todo");
  const [rmKeyPath, setRmKeyPath] = useState("");
  const [rmPrivateKey, setRmPrivateKey] = useState("");
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [gBusy, setGBusy] = useState(false);
  const [gErr, setGErr] = useState("");
  const [keepEmail, setKeepEmail] = useState("");
  const [keepToken, setKeepToken] = useState("");
  const [keepIds, setKeepIds] = useState<string[]>([]);
  const [outlook, setOutlook] = useState<OutlookStatus | null>(null);
  const [outlookIds, setOutlookIds] = useState<Record<string, string[]>>({});
  const [outlookColors, setOutlookColors] = useState<Record<string, Record<string, string>>>({});
  const [outlookErr, setOutlookErr] = useState("");
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [ical, setIcal] = useState<IcalStatus | null>(null);
  const [icalLabel, setIcalLabel] = useState("");
  const [icalUrl, setIcalUrl] = useState("");
  const [icalColor, setIcalColor] = useState(COLOR_PALETTE[0]);
  const [icalErr, setIcalErr] = useState("");
  const [icalBusy, setIcalBusy] = useState(false);
  const [calExport, setCalExport] = useState<CalendarExportStatus | null>(null);
  const [calExportErr, setCalExportErr] = useState("");
  const [calExportBusy, setCalExportBusy] = useState(false);
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [orgName, setOrgName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("user");
  const [orgMsg, setOrgMsg] = useState("");
  const [orgErr, setOrgErr] = useState("");
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState("");
  const [pushHint, setPushHint] = useState("");
  const [pushMsg, setPushMsg] = useState("");
  const [notifyPrefs, setNotifyPrefs] = useState<NotificationPreferences | null>(null);
  const [notifyPrefErr, setNotifyPrefErr] = useState("");
  const [notifyPrefBusy, setNotifyPrefBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [inboxCompact, setInboxCompact] = useState(readInboxCompact);
  const [inboxCompactNotes, setInboxCompactNotes] = useState(readInboxCompactNotes);

  function applyRemarkable(next: RemarkableStatus) {
    setRm(next);
    setRmHost(next.host);
    setRmUser(next.user || "root");
    setRmPort(String(next.port || 21));
    setRmFolder(next.folder || "TTM-Todo");
    setRmOutFolder(next.out_folder || "From TTM-Todo");
    setRmKeyPath(next.key_path || "");
  }

  async function load() {
    setTokens(await api.tokens());
    setBuckets(await api.buckets());
    applyRemarkable(await api.remarkableStatus());
    const google = await api.googleStatus(true);
    setG(google);
    setKeepIds(google.keep.lists.filter((row) => row.selected).map((row) => row.id));
    if (google.keep.label) setKeepEmail(google.keep.label);
    try {
      applyOutlook(await api.outlookStatus(true));
    } catch (e) {
      setOutlookErr(e instanceof Error ? e.message : "Could not load Outlook status");
    }
    try {
      setIcal(await api.icalStatus());
    } catch (e) {
      setIcalErr(e instanceof Error ? e.message : "Could not load calendar subscriptions");
    }
    try {
      setCalExport(await api.calendarExportStatus());
    } catch (e) {
      setCalExportErr(e instanceof Error ? e.message : "Could not load Outlook subscribe status");
    }
    try {
      setNotifyPrefs(await api.notificationPreferences());
      setNotifyPrefErr("");
    } catch (e) {
      setNotifyPrefErr(e instanceof Error ? e.message : "Could not load notification preferences");
    }
    try {
      const nextOrg = await api.orgSettings();
      setOrg(nextOrg);
      setOrgName(nextOrg.organization.name);
    } catch {
      setOrg(null);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthErr = params.get("google_error");
    const outlookOauthErr = params.get("outlook_error");
    if (oauthErr) {
      setGErr(oauthErr);
      params.delete("google_error");
    }
    if (outlookOauthErr) {
      setOutlookErr(outlookOauthErr);
      params.delete("outlook_error");
    }
    if (oauthErr || outlookOauthErr) {
      const qs = params.toString();
      window.history.replaceState({}, "", `/settings${qs ? `?${qs}` : ""}`);
    }
    void load()
      .then(() => {
        if (window.location.hash === "#outlook-tasks") {
          document.getElementById("outlook-tasks")?.scrollIntoView();
        }
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed"));
    void hasPushSubscription()
      .then((on) => setPushOn(on))
      .catch(() => setPushOn(false));
    if (isIosDevice() && !isStandalonePwa()) {
      setPushHint(
        "On iPhone, add TTM-Todo to the Home Screen first, then open that app and enable notifications here. Safari tabs cannot receive them.",
      );
    } else if (isAndroidDevice()) {
      setPushHint(
        "On Android, add TTM-Todo to the Home Screen, open that app, then tap Enable on this device. System notification permission alone is not enough.",
      );
    }
  }, [isSiteAdmin]);

  async function saveOrgName(e: FormEvent) {
    e.preventDefault();
    setOrgErr("");
    setOrgMsg("");
    try {
      await api.renameOrg(orgName.trim());
      setOrgMsg("Organization renamed.");
      const nextOrg = await api.orgSettings();
      setOrg(nextOrg);
    } catch (e) {
      setOrgErr(e instanceof Error ? e.message : "Could not rename");
    }
  }

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    setOrgErr("");
    setOrgMsg("");
    try {
      const result = await api.inviteOrg(inviteEmail.trim(), inviteRole);
      setInviteEmail("");
      setOrgMsg((result.membership ? "Member added." : "Invitation sent.") + mailFailureHint(result));
      setOrg(await api.orgSettings());
    } catch (e) {
      setOrgErr(e instanceof Error ? e.message : "Could not invite");
    }
  }

  async function kick(row: Membership) {
    if (!confirm(`Remove ${row.user?.email || row.user?.username || "this member"} from the organization?`)) return;
    await api.kickMember(row.id);
    setOrg(await api.orgSettings());
  }

  async function revokeInvite(row: Invitation) {
    setOrgErr("");
    setOrgMsg("");
    try {
      await api.revokeInvite(row.id);
      setOrg(await api.orgSettings());
    } catch (e) {
      setOrgErr(e instanceof Error ? e.message : "Could not revoke invitation");
    }
  }

  async function changeRole(row: Membership, role: string) {
    await api.updateMemberRole(row.id, role);
    setOrg(await api.orgSettings());
  }

  async function copyValue(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((cur) => (cur === key ? "" : cur)), 1600);
    } catch {
      setCopied("");
    }
  }

  async function patchNotifyPref(category: string, enabled: boolean | null, projectId?: string) {
    setNotifyPrefErr("");
    setNotifyPrefBusy(true);
    try {
      setNotifyPrefs(
        await api.patchNotificationPreferences({
          category,
          enabled,
          project_id: projectId ?? null,
        }),
      );
    } catch (e) {
      setNotifyPrefErr(e instanceof Error ? e.message : "Could not save notification preference");
    } finally {
      setNotifyPrefBusy(false);
    }
  }

  async function makeToken(e: FormEvent) {
    e.preventDefault();
    const row = await api.createToken(tokenName.trim() || "capture");
    setFreshToken(row.token ?? null);
    setTokenName("");
    await load();
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this token? Capture clients using it will stop working.")) return;
    await api.revokeToken(id);
    if (freshToken) setFreshToken(null);
    await load();
  }

  async function rename(bucket: Bucket) {
    if (bucket.is_inbox || bucket.locked) return;
    const name = prompt("Rename bucket", bucket.name);
    if (!name || name.trim() === bucket.name) return;
    await api.updateBucket(bucket.id, { name: name.trim() });
    await load();
  }

  async function removeBucket(bucket: Bucket) {
    if (bucket.is_inbox || bucket.locked) return;
    if (!confirm(`Delete “${bucket.name}”? Items move back to Inbox.`)) return;
    await api.deleteBucket(bucket.id);
    await load();
  }

  async function saveRemarkable(e: FormEvent) {
    e.preventDefault();
    setRmErr("");
    setRmMsg("");
    setRmBusy(true);
    try {
      const port = Number(rmPort);
      applyRemarkable(
        await api.remarkableSave({
          host: rmHost.trim(),
          user: rmUser.trim() || "root",
          port: Number.isFinite(port) && port > 0 ? port : 21,
          folder: rmFolder.trim() || "TTM-Todo",
          out_folder: rmOutFolder.trim() || "From TTM-Todo",
          key_path: rmKeyPath.trim(),
          private_key: rmPrivateKey,
        }),
      );
      setRmPrivateKey("");
      setRmMsg(rmHost.trim() ? "Tablet connection saved." : "Tablet disabled for this account.");
    } catch (e) {
      setRmErr(e instanceof Error ? e.message : "Could not save tablet settings");
    } finally {
      setRmBusy(false);
    }
  }

  async function syncRemarkable() {
    setRmErr("");
    setRmMsg("");
    setRmBusy(true);
    try {
      applyRemarkable(await api.remarkableSync());
    } catch (e) {
      setRmErr(e instanceof Error ? e.message : "Sync failed");
      try {
        applyRemarkable(await api.remarkableStatus());
      } catch {
        /* keep previous */
      }
    } finally {
      setRmBusy(false);
    }
  }

  function applyGoogle(next: GoogleStatus) {
    setG(next);
    setKeepIds(next.keep.lists.filter((row) => row.selected).map((row) => row.id));
    if (next.keep.label) setKeepEmail(next.keep.label);
  }

  async function syncGoogle() {
    setGErr("");
    setGBusy(true);
    try {
      applyGoogle(await api.googleSync());
    } catch (e) {
      setGErr(e instanceof Error ? e.message : "Google sync failed");
      try {
        applyGoogle(await api.googleStatus());
      } catch {
        /* keep previous */
      }
    } finally {
      setGBusy(false);
    }
  }

  async function disconnectTasks() {
    if (!confirm("Disconnect Google Tasks? Voice items will stop landing in Inbox.")) return;
    setGErr("");
    applyGoogle(await api.googleDisconnectTasks());
  }

  async function connectKeep(e: FormEvent) {
    e.preventDefault();
    setGErr("");
    setGBusy(true);
    try {
      applyGoogle(await api.googleConnectKeep(keepEmail.trim(), keepToken.trim()));
      setKeepToken("");
    } catch (err) {
      setGErr(err instanceof Error ? err.message : "Keep login failed");
    } finally {
      setGBusy(false);
    }
  }

  async function disconnectKeep() {
    if (!confirm("Disconnect Google Keep? Shopping-list voice dumps will stop landing in Inbox.")) return;
    setGErr("");
    applyGoogle(await api.googleDisconnectKeep());
    setKeepToken("");
  }

  async function saveKeepLists() {
    setGErr("");
    applyGoogle(await api.googleSetKeepLists(keepIds, false));
  }

  async function grabAllKeepLists() {
    setGErr("");
    const ids = (g?.keep.lists || []).map((row) => row.id);
    setKeepIds(ids);
    try {
      applyGoogle(await api.googleSetKeepLists(ids, true));
    } catch (err) {
      setGErr(err instanceof Error ? err.message : "Could not grab Keep lists");
    }
  }

  function toggleKeepId(id: string) {
    setKeepIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function applyOutlook(next: OutlookStatus) {
    setOutlook(next);
    const ids: Record<string, string[]> = {};
    const colors: Record<string, Record<string, string>> = {};
    for (const acc of next.accounts || []) {
      ids[acc.id] = acc.calendars.filter((row) => row.selected).map((row) => row.id);
      colors[acc.id] = {};
      for (const row of acc.calendars) {
        colors[acc.id][row.id] = row.color || COLOR_PALETTE[0];
      }
    }
    setOutlookIds(ids);
    setOutlookColors(colors);
  }

  async function disconnectOutlook(accountId: string) {
    const who = accountId || "all Outlook accounts";
    if (!confirm(`Disconnect ${who}? Those calendars will stop showing.`)) return;
    setOutlookErr("");
    applyOutlook(await api.outlookDisconnect(accountId));
  }

  async function saveOutlookCalendars(accountId: string) {
    setOutlookErr("");
    setOutlookBusy(true);
    try {
      applyOutlook(await api.outlookSetCalendars(accountId, outlookIds[accountId] || [], outlookColors[accountId] || {}));
    } catch (err) {
      setOutlookErr(err instanceof Error ? err.message : "Could not save Outlook calendars");
    } finally {
      setOutlookBusy(false);
    }
  }

  function toggleOutlookId(accountId: string, calendarId: string) {
    setOutlookIds((prev) => {
      const cur = prev[accountId] || [];
      const next = cur.includes(calendarId) ? cur.filter((x) => x !== calendarId) : [...cur, calendarId];
      return { ...prev, [accountId]: next };
    });
  }

  function setOutlookColor(accountId: string, calendarId: string, color: string) {
    setOutlookColors((prev) => ({
      ...prev,
      [accountId]: { ...(prev[accountId] || {}), [calendarId]: color },
    }));
  }

  async function patchIcalColor(id: string, color: string) {
    setIcalErr("");
    try {
      setIcal(await api.icalPatchFeed(id, { color }));
    } catch (err) {
      setIcalErr(err instanceof Error ? err.message : "Could not update calendar color");
    }
  }

  async function addIcalFeed(e: FormEvent) {
    e.preventDefault();
    if (!icalUrl.trim()) return;
    setIcalErr("");
    setIcalBusy(true);
    try {
      setIcal(await api.icalAddFeed({ label: icalLabel.trim(), url: icalUrl.trim(), color: icalColor }));
      setIcalLabel("");
      setIcalUrl("");
    } catch (err) {
      setIcalErr(err instanceof Error ? err.message : "Could not add calendar");
    } finally {
      setIcalBusy(false);
    }
  }

  async function removeIcalFeed(id: string) {
    if (!confirm("Remove this calendar subscription?")) return;
    setIcalErr("");
    setIcalBusy(true);
    try {
      setIcal(await api.icalDeleteFeed(id));
    } catch (err) {
      setIcalErr(err instanceof Error ? err.message : "Could not remove calendar");
    } finally {
      setIcalBusy(false);
    }
  }

  async function enableCalExport() {
    setCalExportErr("");
    setCalExportBusy(true);
    try {
      setCalExport(await api.calendarExportEnable());
    } catch (err) {
      setCalExportErr(err instanceof Error ? err.message : "Could not enable Outlook subscribe URL");
    } finally {
      setCalExportBusy(false);
    }
  }

  async function regenerateCalExport() {
    if (!confirm("Regenerate this URL? Outlook will stop updating until you subscribe with the new link.")) return;
    setCalExportErr("");
    setCalExportBusy(true);
    try {
      setCalExport(await api.calendarExportRegenerate());
    } catch (err) {
      setCalExportErr(err instanceof Error ? err.message : "Could not regenerate subscribe URL");
    } finally {
      setCalExportBusy(false);
    }
  }

  async function disableCalExport() {
    if (!confirm("Turn off the Outlook subscribe URL? Calendars using it will stop showing TTM-Todo tasks.")) return;
    setCalExportErr("");
    setCalExportBusy(true);
    try {
      setCalExport(await api.calendarExportDisable());
    } catch (err) {
      setCalExportErr(err instanceof Error ? err.message : "Could not disable subscribe URL");
    } finally {
      setCalExportBusy(false);
    }
  }

  const origin = (publicUrl || window.location.origin).replace(/\/$/, "");
  let tasksOauthOk = false;
  try {
    const here = new URL(window.location.origin);
    const host = here.hostname.toLowerCase();
    tasksOauthOk =
      here.protocol === "https:" ||
      (here.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host));
  } catch {
    tasksOauthOk = false;
  }
  const publicCallback = `${origin}/api/google/callback`;
  const loopbackCallback = "http://127.0.0.1:8010/api/google/callback";
  const outlookCallback = `${origin}/api/outlook/callback`;
  const outlookLoopback = "http://127.0.0.1:8010/api/outlook/callback";
  const inboxUrl = `${origin}/api/inbox`;
  const captureToken = freshToken || "mt_YOUR_TOKEN";
  const authHeader = `Bearer ${captureToken}`;
  const siriJson = `{
  "text": "Buy milk",
  "source": "siri"
}`;
  const curl = `curl -X POST ${inboxUrl} \\
  -H "Authorization: Bearer ${captureToken}" \\
  -F "text=Buy milk" \\
  -F "source=api"`;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <h1 className="brand">
            TTM-<span>Todo</span>
          </h1>
        </div>
        <Link className="nav-btn" to="/">
          ← Inbox
        </Link>
        <Link className="nav-btn" to="/calendar">
          Calendar
        </Link>
        <Link className="nav-btn" to="/org">
          Organization
        </Link>
        <div className="sidebar-foot">
          <p className="hint" style={{ margin: 0 }}>
            Signed in as {username}
            {organizationName ? ` · ${organizationName}` : ""}
          </p>
          {isSiteAdmin ? (
            <Link className="nav-btn" to="/website-admin">
              Website admin
            </Link>
          ) : null}
          <a className="nav-btn" href="/logout">
            Sign out
          </a>
        </div>
        <SidebarResizeHandle />
      </aside>
      <main className="main settings">
        <div className="main-head">
          <h1>Settings</h1>
        </div>
        {err ? <p className="error">{err}</p> : null}

        <section className="panel">
          <h2>Inbox</h2>
          <p className="hint">How todo cards look in Inbox, buckets, All, and Done.</p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={inboxCompact}
              onChange={(e) => {
                const next = e.target.checked;
                setInboxCompact(next);
                writeInboxCompact(next);
              }}
            />
            Compressed view
          </label>
          <label className="toggle nested">
            <input
              type="checkbox"
              checked={inboxCompactNotes}
              disabled={!inboxCompact}
              onChange={(e) => {
                const next = e.target.checked;
                setInboxCompactNotes(next);
                writeInboxCompactNotes(next);
              }}
            />
            Show notes
          </label>
        </section>

        {org ? (
          <section className="panel">
            <h2>Organization</h2>
            <p className="hint">
              Shared planning lives under Organization in the left menu. Everyone still has their own
              private inbox. Org admins can invite people and set roles here. Assign departments under
              Organization. Project managers can run work inside projects but cannot change departments,
              templates, or other organization settings. Department leads see every task in their
              departments across projects.
            </p>
            {orgErr ? <p className="error">{orgErr}</p> : null}
            {orgMsg ? <p className="hint">{orgMsg}</p> : null}
            <p className="hint">
              License: {org.license_summary.status}
              {org.license_summary.license
                ? ` · ${org.license_summary.seats_used}/${org.license_summary.seat_count} seats used`
                : ""}
            </p>
            {org.capabilities.can_manage_organization ? (
              <form onSubmit={(e) => void saveOrgName(e)}>
                <div className="field">
                  <label>Name</label>
                  <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
                </div>
                <button className="btn" type="submit">
                  Rename
                </button>
              </form>
            ) : (
              <p>
                <strong>{org.organization.name}</strong> · {org.membership.role}
              </p>
            )}
            <h3 style={{ marginTop: 18 }}>Members</h3>
            <ul className="hint" style={{ paddingLeft: 18 }}>
              {org.members.map((row) => (
                <li key={row.id} style={{ marginBottom: 8 }}>
                  {row.user?.email || row.user?.username} · {roleLabel(row.role)}
                  {org.capabilities.can_manage_members && row.role !== "owner" ? (
                    <>
                      {" "}
                      <select value={row.role} onChange={(e) => void changeRole(row, e.target.value)}>
                        {(org.invitable_roles.length ? org.invitable_roles : ["admin", "project_manager", "user"]).map((role) => (
                          <option key={role} value={role}>
                            {roleLabel(role)}
                          </option>
                        ))}
                      </select>{" "}
                      <button className="btn ghost small" type="button" onClick={() => void kick(row)}>
                        Remove
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            {org.capabilities.can_invite_members ? (
              <>
                <form onSubmit={(e) => void sendInvite(e)}>
                  <div className="field">
                    <label>Invite email</label>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="field">
                    <label>Role</label>
                    <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                      {(org.invitable_roles.length ? org.invitable_roles : ["user"]).map((role) => (
                        <option key={role} value={role}>
                          {roleLabel(role)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button className="btn" type="submit">
                    Invite
                  </button>
                </form>
                {org.pending_invitations.length ? (
                  <ul className="hint" style={{ paddingLeft: 18 }}>
                    {org.pending_invitations.map((row) => (
                      <li key={row.id}>
                        {row.email} · {row.role}{" "}
                        <button className="btn ghost small" type="button" onClick={() => void revokeInvite(row)}>
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}

        {isSiteAdmin ? <TestMailBox defaultEmail={userEmail} /> : null}

        <section className="panel">
          <h2>Capture tokens</h2>
          <p className="hint">
            Phone shortcuts, a reMarkable bridge, or anything that can POST can dump into Inbox with a
            bearer token. Siri uses the recipe below. Voice from Google Home uses Tasks/Keep further
            down. The full token is shown only once.
          </p>
          {freshToken ? (
            <div className="banner">
              Copy this token now: <span className="mono">{freshToken}</span>
            </div>
          ) : null}
          <form className="composer-row" onSubmit={(e) => void makeToken(e)} style={{ marginBottom: 12 }}>
            <input
              placeholder="Token name (phone, tasker…)"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              required
            />
            <button className="btn small" type="submit">
              Create token
            </button>
          </form>
          {tokens.map((t) => (
            <div className="token-row" key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <div className="hint" style={{ margin: 0 }}>
                  {t.prefix}… {t.last_used_at ? `· last used ${new Date(t.last_used_at).toLocaleString()}` : "· unused"}
                </div>
              </div>
              <button className="btn ghost small" onClick={() => void revoke(t.id)}>
                Revoke
              </button>
            </div>
          ))}
          <h2 style={{ marginTop: 20 }}>Siri</h2>
          <p className="hint">
            Siri cannot write here by itself. An iOS Shortcut POSTs spoken text into Inbox immediately.
            Phrase: <span className="mono">Hey Siri, Add to TTM-Todo</span>
          </p>
          <ol className="recipe">
            <li>
              Create a capture token above (name it <strong>Siri</strong>). Copy it when the banner
              appears — the full value is shown only once.
            </li>
            <li>
              On iPhone or iPad, open <strong>Shortcuts</strong> → New Shortcut. Name it{" "}
              <strong>Add to TTM-Todo</strong> (that name is the Siri phrase).
            </li>
            <li>
              Add <strong>Ask for Input</strong>. Input Type: Text. Prompt:{" "}
              <span className="mono">What should I add?</span>
            </li>
            <li>
              Add <strong>Get Contents of URL</strong>. Method: POST. Paste the URL and headers below.
              Request Body: JSON. Set <span className="mono">text</span> to the Ask for Input result and{" "}
              <span className="mono">source</span> to <span className="mono">siri</span>.
            </li>
            <li>
              Turn <strong>Show When Run</strong> off so HomePod can run it without a screen. The
              shortcut must stay on iCloud Shortcuts.
            </li>
            <li>
              Say <span className="mono">Hey Siri, Add to TTM-Todo</span>. Siri asks for the item; it
              lands in Inbox tagged <span className="mono">siri</span>.
            </li>
          </ol>
          <CopyRow
            label="URL"
            value={inboxUrl}
            copied={copied === "url"}
            onCopy={() => void copyValue("url", inboxUrl)}
          />
          <CopyRow
            label="Authorization"
            value={authHeader}
            copied={copied === "auth"}
            onCopy={() => void copyValue("auth", authHeader)}
          />
          <CopyRow
            label="Content-Type"
            value="application/json"
            copied={copied === "ctype"}
            onCopy={() => void copyValue("ctype", "application/json")}
          />
          <div className="token-row" style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong>JSON body</strong>
              <p className="hint" style={{ margin: "4px 0 8px" }}>
                In Shortcuts, bind <span className="mono">text</span> to Ask for Input instead of a
                fixed string.
              </p>
              <pre className="curl" style={{ margin: 0 }}>
                {siriJson}
              </pre>
            </div>
            <button className="btn ghost small" type="button" onClick={() => void copyValue("json", siriJson)}>
              {copied === "json" ? "Copied" : "Copy"}
            </button>
          </div>
          <h2 style={{ marginTop: 20 }}>curl</h2>
          <pre className="curl">{curl}</pre>
        </section>

        <section className="panel">
          <h2>Buckets</h2>
          <p className="hint">Inbox cannot be deleted. Organization and project folders stay locked while those still exist. Deleting another bucket moves its items to Inbox and keeps its sub-buckets.</p>
          {walkBucketTree(buckets).map(({ bucket: b, depth }) => (
            <div className="token-row" key={b.id} style={{ paddingLeft: depth * 16 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span className="dot" style={{ background: b.color }} />
                <strong>{b.name}</strong>
              </div>
              {b.is_inbox ? (
                <span className="hint" style={{ margin: 0 }}>
                  default dump
                </span>
              ) : b.locked ? (
                <span className="hint" style={{ margin: 0 }}>
                  {b.organization_id ? "organization folder" : "project folder"}
                </span>
              ) : (
                <div className="composer-row">
                  <button className="btn ghost small" onClick={() => void rename(b)}>
                    Rename
                  </button>
                  <button className="btn ghost small" onClick={() => void removeBucket(b)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="panel">
          <h2>reMarkable</h2>
          <p className="hint">
            This login’s tablet only. NEXSERVE SSHs to the tablet (Wi-Fi or Tailscale). Put notebooks
            in a folder named <span className="mono">{rm?.folder || "TTM-Todo"}</span> — each page
            becomes an Inbox item. <strong>Send to reMarkable</strong> on a card writes a PDF into{" "}
            <span className="mono">{rm?.out_folder || "From TTM-Todo"}</span> (the tablet UI may
            flicker for a second). Leave host empty to disable. Other family members do not share this
            tablet.
          </p>
          {rmErr ? <p className="error">{rmErr}</p> : null}
          {rmMsg ? <p className="hint">{rmMsg}</p> : null}
          {rm ? (
            <p className="hint">
              {rm.configured ? (
                <>
                  Host{" "}
                  <span className="mono">
                    {rm.user}@{rm.host || "—"}:{rm.port || 21}
                  </span>
                  {rm.reachable === false ? " · last try: unreachable" : null}
                  {rm.reachable === true ? " · reachable" : null}
                  {rm.last_at
                    ? ` · last sync ${new Date(rm.last_at).toLocaleString()} (imported ${rm.imported}, updated ${rm.updated}, skipped_existing ${rm.skipped_existing}, skipped_no_file ${rm.skipped_no_file}, skipped_no_image ${rm.skipped_no_image})`
                    : " · not synced yet"}
                  {rm.error ? ` · ${rm.error}` : null}
                </>
              ) : (
                <>No tablet host saved for this account. Fill in the form below to connect one.</>
              )}
            </p>
          ) : null}
          <form onSubmit={(e) => void saveRemarkable(e)}>
            <div className="field">
              <label>Host</label>
              <input
                value={rmHost}
                onChange={(e) => setRmHost(e.target.value)}
                placeholder="tablet Tailscale name or IP"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label>SSH user</label>
              <input value={rmUser} onChange={(e) => setRmUser(e.target.value)} autoComplete="off" />
            </div>
            <div className="field">
              <label>SSH port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={rmPort}
                onChange={(e) => setRmPort(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Inbox folder on tablet</label>
              <input value={rmFolder} onChange={(e) => setRmFolder(e.target.value)} />
            </div>
            <div className="field">
              <label>Send-to folder on tablet</label>
              <input value={rmOutFolder} onChange={(e) => setRmOutFolder(e.target.value)} />
            </div>
            <div className="field">
              <label>SSH private key path (optional)</label>
              <input
                value={rmKeyPath}
                onChange={(e) => setRmKeyPath(e.target.value)}
                placeholder="/home/…/.ssh/id_ed25519"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label>Paste private key (optional)</label>
              <textarea
                rows={4}
                value={rmPrivateKey}
                onChange={(e) => setRmPrivateKey(e.target.value)}
                placeholder="Leave blank to keep the current key"
                autoComplete="off"
              />
            </div>
            <div className="settings-actions">
              <button className="btn" type="submit" disabled={rmBusy}>
                {rmBusy ? "Saving…" : "Save tablet"}
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={rmBusy || !rm?.configured}
                onClick={() => void syncRemarkable()}
              >
                {rmBusy ? "Syncing…" : "Sync now"}
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <h2>Google voice (Tasks + Keep)</h2>
          <p className="hint">
            Google Home will not POST spoken text here. Say the item into a list Google actually writes
            to, then TTM-Todo polls it every couple of minutes.
            <br />
            Tasks: <span className="mono">Hey Google, add buy milk to my TTM-Todo list</span>
            <br />
            Keep: <span className="mono">Hey Google, add milk to my shopping list</span>
          </p>
          {gErr ? <p className="error">{gErr}</p> : null}
          {g?.last_at ? (
            <p className="hint">
              Last pull {new Date(g.last_at).toLocaleString()}
              {g.last_ok === false ? " · had errors" : ""}
              {g.tasks.connected
                ? ` · Tasks imported ${g.tasks.imported}, skipped ${g.tasks.skipped}`
                : ""}
              {g.keep.connected
                ? ` · Keep imported ${g.keep.imported}, skipped ${g.keep.skipped}`
                : ""}
              {g.error ? ` · ${g.error}` : null}
            </p>
          ) : (
            <p className="hint">Not pulled yet. Connect a source, then Sync now or wait for the timer.</p>
          )}

          <h2 style={{ marginTop: 18 }}>Google Tasks</h2>
          <p className="hint">
            Connect Tasks from this HTTPS site. On the NexApp <strong>Web</strong> client register{" "}
            <span className="mono">{publicCallback}</span>
            {origin.includes("127.0.0.1") ? null : (
              <>
                {" "}
                (HTTP still works only on loopback:{" "}
                <span className="mono">ssh -L 8010:127.0.0.1:8010 nexserve</span>, then{" "}
                <span className="mono">http://127.0.0.1:8010/settings</span>, redirect{" "}
                <span className="mono">{loopbackCallback}</span>)
              </>
            )}
            . Enable the Tasks API. Add each family Gmail as a consent-screen test user on NexApp
            (Testing), or they will hit access_denied.
          </p>
          {g?.tasks.configured ? (
            g.tasks.connected ? (
              <>
                <p className="hint">
                  Connected · watching all lists
                  {g.tasks.lists.length
                    ? ` (${g.tasks.lists.map((row) => row.title).join(", ")})`
                    : null}
                  {g.tasks.error ? ` · ${g.tasks.error}` : null}
                </p>
                <p className="hint">
                  Every incomplete task on every Google Tasks list lands in Inbox. Completed and blank
                  titles are skipped. After import the Google item is marked done so the list stays a
                  drop box.
                </p>
                <div className="settings-actions">
                  <button className="btn ghost small" type="button" onClick={() => void disconnectTasks()}>
                    Disconnect Tasks
                  </button>
                </div>
              </>
            ) : (
              <>
                {tasksOauthOk ? null : (
                  <p className="error">
                    This page is not on HTTPS or 127.0.0.1, so Connect Tasks would be blocked by Google.
                    Open <span className="mono">https://todo.takttimemodular.com/settings</span> or the
                    SSH tunnel URL.
                  </p>
                )}
                <div className="settings-actions">
                  <a className="btn" href="/api/google/tasks/connect">
                    Connect Tasks
                  </a>
                </div>
              </>
            )
          ) : (
            <p className="hint">
              Disabled until <span className="mono">GOOGLE_CLIENT_ID</span> and{" "}
              <span className="mono">GOOGLE_CLIENT_SECRET</span> are set in <span className="mono">.env</span>,
              then restart magictodo.
            </p>
          )}

          <h2 style={{ marginTop: 22 }}>Google Keep</h2>
          <p className="hint">
            Personal Gmail cannot use the official Keep API. This login uses Keep’s app protocol
            (gkeepapi) with your email and a <strong>master token</strong>, not the Tasks OAuth client.
            If Google breaks that protocol, Keep import stops; Tasks still works. Default watch list:
            Shopping list and any list titled TTM-Todo or MagicTODO.
          </p>
          <p className="hint">
            Mint a token on NEXSERVE: sign in at{" "}
            <a href="https://accounts.google.com/EmbeddedSetup" target="_blank" rel="noreferrer">
              accounts.google.com/EmbeddedSetup
            </a>{" "}
            (a spinner hang is normal), copy the <span className="mono">oauth_token</span> cookie, then
            run{" "}
            <span className="mono">
              .venv/bin/python scripts/google_keep_master_token.py --username {username}
            </span>
            . Paste the Token below. Do not put it in <span className="mono">.env</span>.
          </p>
          {g?.keep.connected ? (
            <>
              <p className="hint">
                Connected as <span className="mono">{g.keep.label}</span>
                {g.keep.error ? ` · ${g.keep.error}` : null}
              </p>
              {g.keep.lists.length ? (
                <>
                  <p className="hint" style={{ marginBottom: 8 }}>
                    Keep lists to watch
                  </p>
                  <div className="keep-lists">
                    {g.keep.lists.map((row) => (
                      <label key={row.id}>
                        <input
                          type="checkbox"
                          checked={keepIds.includes(row.id)}
                          onChange={() => toggleKeepId(row.id)}
                        />
                        <span>{row.title}</span>
                      </label>
                    ))}
                  </div>
                  <div className="settings-actions">
                    <button className="btn small" type="button" onClick={() => void saveKeepLists()}>
                      Save Keep lists
                    </button>
                    <button className="btn ghost small" type="button" onClick={() => void grabAllKeepLists()}>
                      Grab all lists
                    </button>
                    <button className="btn ghost small" type="button" onClick={() => void disconnectKeep()}>
                      Disconnect Keep
                    </button>
                  </div>
                  <p className="hint">
                    Grab all lists watches every Keep list, including ones you create later, until you
                    save a subset instead.
                  </p>
                </>
              ) : (
                <div className="settings-actions">
                  <button className="btn ghost small" type="button" onClick={() => void disconnectKeep()}>
                    Disconnect Keep
                  </button>
                </div>
              )}
            </>
          ) : (
            <form onSubmit={(e) => void connectKeep(e)}>
              <div className="field">
                <label>Keep email</label>
                <input
                  type="email"
                  autoComplete="username"
                  value={keepEmail}
                  onChange={(e) => setKeepEmail(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label>Master token</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={keepToken}
                  onChange={(e) => setKeepToken(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <button className="btn" type="submit" disabled={gBusy}>
                {gBusy ? "Connecting…" : "Connect Keep"}
              </button>
            </form>
          )}

          <div className="settings-actions" style={{ marginTop: 18 }}>
            <button
              className="btn"
              type="button"
              disabled={gBusy || (!g?.tasks.connected && !g?.keep.connected)}
              onClick={() => void syncGoogle()}
            >
              {gBusy ? "Syncing…" : "Sync Google now"}
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Outlook calendar</h2>
          <p className="hint">
            Overlay Outlook calendars from one or more Microsoft accounts (work and personal) on the
            Calendar page. Read-only. Register a Microsoft Entra app with redirect{" "}
            <span className="mono">{outlookCallback}</span>
            {origin.includes("127.0.0.1") ? null : (
              <>
                {" "}
                (HTTP still works only on loopback:{" "}
                <span className="mono">{outlookLoopback}</span>)
              </>
            )}
            . Scopes: <span className="mono">Calendars.Read</span>, <span className="mono">User.Read</span>,{" "}
            <span className="mono">offline_access</span>.
          </p>
          {outlookErr ? <p className="error">{outlookErr}</p> : null}
          {outlook?.configured ? (
            <>
              {(outlook.accounts || []).map((acc) => (
                <div key={acc.id} className="outlook-account">
                  <p className="hint">
                    Connected as <span className="mono">{acc.label || acc.id}</span>
                    {acc.error ? ` · ${acc.error}` : null}
                  </p>
                  {acc.calendars.length ? (
                    <>
                      <p className="hint" style={{ marginBottom: 8 }}>
                        Calendars to show
                      </p>
                      <div className="keep-lists">
                        {acc.calendars.map((row) => (
                          <div key={row.id} className="cal-pick">
                            <label>
                              <input
                                type="checkbox"
                                checked={(outlookIds[acc.id] || []).includes(row.id)}
                                onChange={() => toggleOutlookId(acc.id, row.id)}
                              />
                              <span>{row.name}</span>
                            </label>
                            <ColorPicker
                              value={outlookColors[acc.id]?.[row.id] || row.color || COLOR_PALETTE[0]}
                              onChange={(c) => setOutlookColor(acc.id, row.id, c)}
                            />
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                  <div className="settings-actions">
                    {acc.calendars.length ? (
                      <button
                        className="btn small"
                        type="button"
                        disabled={outlookBusy}
                        onClick={() => void saveOutlookCalendars(acc.id)}
                      >
                        Save calendars
                      </button>
                    ) : null}
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => void disconnectOutlook(acc.id)}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              ))}
              {tasksOauthOk ? null : (
                <p className="error">
                  This page is not on HTTPS or 127.0.0.1, so adding an Outlook account would be blocked.
                  Open Settings on HTTPS or the SSH tunnel URL.
                </p>
              )}
              <div className="settings-actions">
                <a className="btn" href="/api/outlook/connect">
                  {outlook.connected ? "Add Outlook account" : "Connect Outlook"}
                </a>
              </div>
            </>
          ) : (
            <p className="hint">
              Disabled until <span className="mono">MICROSOFT_CLIENT_ID</span> and{" "}
              <span className="mono">MICROSOFT_CLIENT_SECRET</span> are set in{" "}
              <span className="mono">.env</span>, then restart magictodo.
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Calendar subscription (ICS)</h2>
          <p className="hint">
            Overlay a published calendar without Microsoft Entra. In Outlook on the web: Settings →
            Calendar → Shared calendars → Publish a calendar, then paste the secret ICS URL here.
            Google Calendar and other HTTPS <span className="mono">.ics</span> feeds work too. Read-only.
            The URL is a secret — treat it like a password.
          </p>
          {icalErr ? <p className="error">{icalErr}</p> : null}
          {(ical?.feeds || []).map((feed) => (
            <div key={feed.id} className="outlook-account">
              <p className="hint">
                <span className="dot" style={{ background: feed.color, display: "inline-block", width: 10, height: 10, borderRadius: 99, marginRight: 8 }} />
                {feed.label || "Calendar"}
                {feed.error ? ` · ${feed.error}` : null}
              </p>
              <p className="hint mono" style={{ wordBreak: "break-all" }}>
                {feed.url}
              </p>
              <ColorPicker value={feed.color} onChange={(c) => void patchIcalColor(feed.id, c)} />
              <div className="settings-actions">
                <button
                  className="btn ghost small"
                  type="button"
                  disabled={icalBusy}
                  onClick={() => void removeIcalFeed(feed.id)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <form onSubmit={(e) => void addIcalFeed(e)}>
            <div className="field">
              <label>Label</label>
              <input value={icalLabel} onChange={(e) => setIcalLabel(e.target.value)} placeholder="Work" />
            </div>
            <div className="field">
              <label>ICS URL</label>
              <input
                value={icalUrl}
                onChange={(e) => setIcalUrl(e.target.value)}
                placeholder="https://outlook.office.com/owa/calendar/…/calendar.ics"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>
              Color
            </p>
            <ColorPicker value={icalColor} onChange={setIcalColor} />
            <div className="settings-actions">
              <button className="btn" type="submit" disabled={icalBusy || !icalUrl.trim()}>
                {icalBusy ? "Saving…" : "Add subscription"}
              </button>
            </div>
          </form>
        </section>

        <section className="panel" id="outlook-tasks">
          <h2>Show tasks in Outlook</h2>
          <p className="hint">
            Outlook (and other calendars) can subscribe to a live feed of your open TTM-Todo due dates.
            There is no file download — paste the secret URL so Outlook keeps refreshing as tasks change.
            Outlook on the web: Add calendar → Subscribe from web. Outlook desktop: Add Calendar → From
            Internet.
          </p>
          {calExportErr ? <p className="error">{calExportErr}</p> : null}
          {origin.startsWith("https://") || origin.includes("127.0.0.1") ? null : (
            <p className="hint">
              Outlook on the web can only refresh this feed if the site is reachable over HTTPS. Desktop
              Outlook can use this URL if it can reach {origin}.
            </p>
          )}
          {calExport?.enabled && calExport.path ? (
            <>
              <p className="hint">The URL is a secret — treat it like a password.</p>
              <CopyRow
                label="Subscribe URL"
                value={`${origin}${calExport.path}`}
                copied={copied === "cal-export"}
                onCopy={() => void copyValue("cal-export", `${origin}${calExport.path}`)}
              />
              <div className="settings-actions">
                <button
                  className="btn"
                  type="button"
                  disabled={calExportBusy}
                  onClick={() => void regenerateCalExport()}
                >
                  {calExportBusy ? "Working…" : "Regenerate URL"}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={calExportBusy}
                  onClick={() => void disableCalExport()}
                >
                  Turn off
                </button>
              </div>
            </>
          ) : (
            <div className="settings-actions">
              <button
                className="btn"
                type="button"
                disabled={calExportBusy}
                onClick={() => void enableCalExport()}
              >
                {calExportBusy ? "Working…" : "Enable subscribe URL"}
              </button>
            </div>
          )}
        </section>

        <section className="panel" id="notifications">
          <h2>Notifications</h2>
          <p className="hint">
            Choose which alerts you receive. Defaults apply to every project; a project can override
            them. Reminders also show as phone notifications from the installed app when Web Push is
            enabled on this device.
          </p>
          {notifyPrefErr ? <p className="error">{notifyPrefErr}</p> : null}
          {notifyPrefs ? (
            <>
              <h3 className="notify-prefs-heading">Default for all projects</h3>
              <div className="notify-prefs">
                {notifyPrefs.categories.map((category) => (
                  <label className="toggle" key={category.id}>
                    <input
                      type="checkbox"
                      checked={Boolean(notifyPrefs.global[category.id])}
                      disabled={notifyPrefBusy}
                      onChange={(e) => void patchNotifyPref(category.id, e.target.checked)}
                    />
                    {category.label}
                  </label>
                ))}
              </div>
              {notifyPrefs.projects.length > 0 ? (
                <>
                  <h3 className="notify-prefs-heading">Per project</h3>
                  <p className="hint">Use default follows the toggles above.</p>
                  {notifyPrefs.projects.map((project) => (
                    <div className="notify-project" key={project.id}>
                      <h3>{project.name}</h3>
                      {notifyPrefs.categories
                        .filter((category) => category.project_scoped)
                        .map((category) => {
                          const value = project.prefs[category.id];
                          const selectValue = value === null || value === undefined ? "inherit" : value ? "on" : "off";
                          return (
                            <label className="notify-pref-row" key={`${project.id}-${category.id}`}>
                              <span>{category.label}</span>
                              <select
                                className="sort-select"
                                value={selectValue}
                                disabled={notifyPrefBusy}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  const enabled = next === "inherit" ? null : next === "on";
                                  void patchNotifyPref(category.id, enabled, project.id);
                                }}
                              >
                                <option value="inherit">Use default</option>
                                <option value="on">On</option>
                                <option value="off">Off</option>
                              </select>
                            </label>
                          );
                        })}
                    </div>
                  ))}
                </>
              ) : null}
            </>
          ) : null}
          {pushErr ? <p className="error">{pushErr}</p> : null}
          {pushMsg ? <p className="hint">{pushMsg}</p> : null}
          {pushHint ? <p className="hint">{pushHint}</p> : null}
          {!pushSupported() ? (
            <p className="hint">This browser does not support push notifications.</p>
          ) : (
            <>
              <p className="hint">
                {typeof Notification !== "undefined" && Notification.permission === "denied"
                  ? "Notifications are blocked for this site. Enable them in the browser or system settings."
                  : pushOn
                    ? "Enabled on this device."
                    : "Not enabled on this device."}
              </p>
              <div className="settings-actions">
                {pushOn ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={pushBusy}
                    onClick={() => {
                      setPushErr("");
                      setPushMsg("");
                      setPushBusy(true);
                      void unsubscribePush()
                        .then(() => setPushOn(false))
                        .catch((e: unknown) =>
                          setPushErr(e instanceof Error ? e.message : "Could not disable"),
                        )
                        .finally(() => setPushBusy(false));
                    }}
                  >
                    {pushBusy ? "Working…" : "Disable on this device"}
                  </button>
                ) : (
                  <button
                    className="btn"
                    type="button"
                    disabled={pushBusy}
                    onClick={() => {
                      setPushErr("");
                      setPushMsg("");
                      setPushBusy(true);
                      void subscribePush()
                        .then((ok) => {
                          setPushOn(ok);
                          if (!ok) {
                            setPushErr("Permission was not granted.");
                          }
                        })
                        .catch((e: unknown) =>
                          setPushErr(e instanceof Error ? e.message : "Could not enable"),
                        )
                        .finally(() => setPushBusy(false));
                    }}
                  >
                    {pushBusy ? "Working…" : "Enable on this device"}
                  </button>
                )}
                {pushOn ? (
                  <button
                    className="btn"
                    type="button"
                    disabled={pushBusy}
                    onClick={() => {
                      setPushErr("");
                      setPushMsg("");
                      setPushBusy(true);
                      void api
                        .pushTest()
                        .then((row) => {
                          if (row.delivered > 0) {
                            setPushMsg("Test sent. Check the notification shade.");
                          } else if (row.devices === 0) {
                            setPushErr("No device is registered. Tap Enable on this device first.");
                          } else {
                            setPushErr("Could not deliver to this device. Try Enable again.");
                          }
                        })
                        .catch((e: unknown) =>
                          setPushErr(e instanceof Error ? e.message : "Could not send test"),
                        )
                        .finally(() => setPushBusy(false));
                    }}
                  >
                    {pushBusy ? "Working…" : "Send test notification"}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Install as an app</h2>
          <p className="hint">
            On Android Chrome: menu → Add to Home screen. On iPhone: Share → Add to Home Screen
            (iOS 16.4+). After it is installed, stay signed in, then Share a photo or text from any
            app into TTM-Todo. It lands in Inbox.
          </p>
        </section>
      </main>
    </div>
  );
}

function CopyRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="token-row">
      <div style={{ minWidth: 0 }}>
        <strong>{label}</strong>
        <div className="hint mono" style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>
          {value}
        </div>
      </div>
      <button className="btn ghost small" type="button" onClick={onCopy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
