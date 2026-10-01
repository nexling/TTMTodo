import { Link } from "react-router-dom";
import { useAuthStatus } from "../authStatus";

export default function NoOrganization() {
  const status = useAuthStatus();
  const admin = Boolean(status?.is_site_admin);
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
        {admin ? (
          <Link className="nav-btn" to="/website-admin">
            Website admin
          </Link>
        ) : null}
      </aside>
      <main className="main">
        <div className="main-head">
          <h1>Organization</h1>
        </div>
        <section className="panel">
          <p className="lede">You are not in an organization.</p>
          <p className="hint">A site admin has to create one and invite you.</p>
          <p>
            <Link className="btn" to="/">
              Inbox
            </Link>
            {admin ? (
              <Link className="btn ghost" to="/website-admin" style={{ marginLeft: 8 }}>
                Website admin
              </Link>
            ) : null}
          </p>
        </section>
      </main>
    </div>
  );
}
