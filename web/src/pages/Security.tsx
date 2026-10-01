import { Link } from "react-router-dom";
import { useHasOrganization } from "../authStatus";
import SidebarResizeHandle from "../components/SidebarResizeHandle";

type Props = {
  username: string;
  isSiteAdmin?: boolean;
  organizationName?: string;
};

export default function Security({ username, isSiteAdmin, organizationName }: Props) {
  const hasOrganization = useHasOrganization();
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
        {hasOrganization ? (
          <Link className="nav-btn" to="/org">
            Organization
          </Link>
        ) : null}
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
          <h1>How we handle your data</h1>
        </div>

        <section className="panel">
          <h2>Who can see what</h2>
          <p className="hint">
            Your inbox, photos, due dates, and capture tokens are personal. Other people in an
            organization cannot open them. Organization Plan projects, departments, and Plan files
            are shared with members of that organization. Each customer company has one
            organization.
          </p>
        </section>

        <section className="panel">
          <h2>Who operates this</h2>
          <p className="hint">
            TTM-Todo runs on a server operated by Takt Time Modular. The operator can technically read everything
            stored here, including todos, photos, and connected Outlook tokens. Other customers cannot.
            This is not end-to-end encrypted.
          </p>
        </section>

        <section className="panel">
          <h2>Leaving</h2>
          <p className="hint">
            Email the operator. Within seven days we delete your account on this server: inbox, photos,
            capture tokens, calendar subscribe URL, Outlook connection files stored here, and
            organization membership. We do not revoke your Microsoft or Auth0 account for you. Sign
            out of those yourself if you connected them.
          </p>
        </section>

        <section className="panel">
          <h2>Backups</h2>
          <p className="hint">
            Encrypted restic backups go to a separate NAS on a schedule. If this machine dies, restore
            depends on that copy.
          </p>
        </section>

        <section className="panel">
          <h2>Secret URLs and tokens</h2>
          <p className="hint">
            Capture API tokens and the Outlook subscribe URL are secrets. Anyone with the value can
            write to your inbox or read your open due dates. They are shown only when you create or
            regenerate them. Treat a leak as a password leak and regenerate.
          </p>
        </section>

        <section className="panel">
          <h2>What clients can connect</h2>
          <p className="hint">
            Licensed users can use inbox, photos, capture tokens, Outlook calendar overlay, and the
            Outlook subscribe feed.
          </p>
        </section>
      </main>
    </div>
  );
}
