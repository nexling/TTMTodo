import { Link } from "react-router-dom";
import { useHasOrganization } from "../authStatus";
import { useDepartmentWorkNav } from "../planAccess";

export default function OrgNavLinks({
  active,
  onNavigate,
  linkClassName = "bucket-link",
}: {
  active?: "org" | "project" | "template" | "department" | "todos";
  onNavigate?: () => void;
  linkClassName?: string;
}) {
  const hasOrg = useHasOrganization();
  const showDepartmentWork = useDepartmentWorkNav();
  if (!hasOrg) return null;
  return (
    <>
      <Link
        className={`${linkClassName}${active === "org" ? " active" : ""}`}
        to="/org"
        onClick={onNavigate}
      >
        Organization
      </Link>
      {showDepartmentWork ? (
        <Link
          className={`${linkClassName}${active === "department" ? " active" : ""}`}
          to="/org/departments"
          onClick={onNavigate}
        >
          Org: All Projects
        </Link>
      ) : null}
      <Link
        className={`${linkClassName}${active === "todos" ? " active" : ""}`}
        to="/org/my-todos"
        onClick={onNavigate}
      >
        My Org Todo's
      </Link>
    </>
  );
}
