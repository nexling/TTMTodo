import { Link } from "react-router-dom";
import OrgNavLinks from "./OrgNavLinks";
import SidebarResizeHandle from "./SidebarResizeHandle";
import WhatsNewLink from "./WhatsNewLink";

export default function OrgSidebar({
  active,
}: {
  active: "org" | "project" | "template" | "department" | "todos";
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <h1 className="brand">
          TTM-<span>Todo</span>
        </h1>
      </div>
      <Link className="bucket-link" to="/">
        Inbox
      </Link>
      <Link className="bucket-link" to="/all">
        All
      </Link>
      <Link className="bucket-link" to="/done">
        Done today
      </Link>
      <Link className="bucket-link" to="/calendar">
        Calendar
      </Link>
      <OrgNavLinks active={active} />
      <div className="sidebar-foot">
        <Link className="nav-btn" to="/settings">
          Settings
        </Link>
        <WhatsNewLink />
      </div>
      <SidebarResizeHandle />
    </aside>
  );
}
