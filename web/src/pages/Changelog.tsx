import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuthStatus, useHasOrganization } from "../authStatus";
import { CHANGELOG_MD, markChangelogSeen } from "../changelog";
import { renderChangelogMarkdown } from "../changelogMarkdown";
import SidebarResizeHandle from "../components/SidebarResizeHandle";

export default function Changelog() {
  const status = useAuthStatus();
  const hasOrganization = useHasOrganization();
  const username = status?.user?.name || status?.user?.email || status?.user?.username || "";
  const organizationName = status?.organization?.name;

  useEffect(() => {
    markChangelogSeen();
  }, []);

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
          {status?.is_site_admin ? (
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
          <h1>What's new</h1>
        </div>
        <section className="panel changelog-md">{renderChangelogMarkdown(CHANGELOG_MD)}</section>
      </main>
    </div>
  );
}
