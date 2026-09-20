import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, mailFailureHint, type AdminContext } from "../api";
import SidebarResizeHandle from "../components/SidebarResizeHandle";
import TestMailBox from "../components/TestMailBox";

type Props = {
  onLogout: () => void;
};

export default function WebsiteAdmin({ onLogout }: Props) {
  const [ctx, setCtx] = useState<AdminContext | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [indEmail, setIndEmail] = useState("");
  const [indExpires, setIndExpires] = useState("");
  const [orgId, setOrgId] = useState("");
  const [orgSeats, setOrgSeats] = useState("1");
  const [orgExpires, setOrgExpires] = useState("");
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgOwner, setNewOrgOwner] = useState("");

  async function load() {
    setErr("");
    setCtx(await api.adminContext());
  }

  useEffect(() => {
    void load().catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed"));
  }, []);

  async function saveIndividual(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    try {
      const saved = await api.saveIndividualLicense(indEmail.trim(), indExpires);
      setIndEmail("");
      setMsg("Individual license saved." + mailFailureHint(saved));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save license");
    }
  }

  async function createOrg(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    try {
      const created = await api.createOrganization(newOrgName.trim(), newOrgOwner.trim());
      setNewOrgName("");
      setNewOrgOwner("");
      setOrgId(created.organization.id);
      setMsg(
        (created.pending_owner_email
          ? `Organization created. Waiting for ${created.pending_owner_email} to sign in.`
          : "Organization created.") + mailFailureHint(created),
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create organization");
    }
  }

  async function saveOrg(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    try {
      await api.saveOrganizationLicense(orgId, Number(orgSeats), orgExpires);
      setMsg("Organization license saved.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save license");
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this license?")) return;
    await api.deleteLicense(id);
    await load();
  }

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
        <Link className="nav-btn" to="/settings">
          Settings
        </Link>
        <div className="sidebar-foot">
          <a className="nav-btn" href="/logout" onClick={onLogout}>
            Sign out
          </a>
        </div>
        <SidebarResizeHandle />
      </aside>
      <main className="main settings">
        <div className="main-head">
          <h1>Website admin</h1>
        </div>
        {err ? <p className="error">{err}</p> : null}
        {msg ? <p className="hint">{msg}</p> : null}

        <TestMailBox />

        <section className="panel">
          <h2>Individual licenses</h2>
          <p className="hint">Tied to an email. Does not consume an organization seat.</p>
          <form onSubmit={(e) => void saveIndividual(e)}>
            <div className="field">
              <label>Email</label>
              <input type="email" value={indEmail} onChange={(e) => setIndEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label>Expires</label>
              <input type="date" value={indExpires} onChange={(e) => setIndExpires(e.target.value)} required />
            </div>
            <button className="btn" type="submit">
              Save individual license
            </button>
          </form>
          <ul className="hint" style={{ paddingLeft: 18 }}>
            {(ctx?.individual_licenses || []).map((row) => (
              <li key={row.id}>
                <span className="mono">{row.assigned_email}</span> · {row.status} · {row.expires_on}
                {" "}
                <button className="btn ghost small" type="button" onClick={() => void remove(row.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Create organization</h2>
          <p className="hint">
            Owner can be an email that has not signed in yet. They become owner on their first Auth0 login.
          </p>
          <form onSubmit={(e) => void createOrg(e)}>
            <div className="field">
              <label>Name</label>
              <input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} required maxLength={120} />
            </div>
            <div className="field">
              <label>Owner email</label>
              <input
                type="email"
                value={newOrgOwner}
                onChange={(e) => setNewOrgOwner(e.target.value)}
                required
              />
            </div>
            <button className="btn" type="submit">
              Create organization
            </button>
          </form>
        </section>

        <section className="panel">
          <h2>Organization licenses</h2>
          <form onSubmit={(e) => void saveOrg(e)}>
            <div className="field">
              <label>Organization</label>
              <select value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
                <option value="">Select…</option>
                {(ctx?.organizations || []).map((row) => (
                  <option key={row.organization.id} value={row.organization.id}>
                    {row.organization.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Seats</label>
              <input
                type="number"
                min={1}
                value={orgSeats}
                onChange={(e) => setOrgSeats(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label>Expires</label>
              <input type="date" value={orgExpires} onChange={(e) => setOrgExpires(e.target.value)} required />
            </div>
            <button className="btn" type="submit">
              Save organization license
            </button>
          </form>
          <ul className="hint" style={{ paddingLeft: 18 }}>
            {(ctx?.organizations || []).map((row) => (
              <li key={row.organization.id}>
                <strong>{row.organization.name}</strong>
                {row.owner?.email || row.owner?.name
                  ? ` · owner ${row.owner.email || row.owner.name}`
                  : row.pending_owner_email
                    ? ` · waiting for ${row.pending_owner_email}`
                    : " · no owner"}
                {" · "}
                {row.license_summary.status}
                {row.license_summary.license
                  ? ` · ${row.license_summary.seats_used}/${row.license_summary.seat_count} seats · ${row.license_summary.license.expires_on}`
                  : " · no license"}
                {row.license_summary.license ? (
                  <>
                    {" "}
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => void remove(row.license_summary.license!.id)}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
