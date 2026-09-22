import { Link } from "react-router-dom";
import SidebarResizeHandle from "./SidebarResizeHandle";
import { useDepartmentWorkNav } from "../planAccess";

export default function OrgSidebar({
  active,
}: {
  active: "org" | "project" | "template" | "department";
}) {
  const showDepartmentWork = useDepartmentWorkNav();
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
      <Link className={`bucket-link${active === "org" ? " active" : ""}`} to="/org">
        Organization
      </Link>
      {showDepartmentWork ? (
        <Link className={`bucket-link${active === "department" ? " active" : ""}`} to="/org/departments">
          Org-all Projects
        </Link>
      ) : null}
      <div className="sidebar-foot">
        <Link className="nav-btn" to="/settings">
          Settings
        </Link>
      </div>
      <SidebarResizeHandle />
    </aside>
  );
}
