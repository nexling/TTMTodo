import { useEffect, useState } from "react";
import { api } from "./api";
import { useHasOrganization } from "./authStatus";

export function useDepartmentWorkNav() {
  const hasOrg = useHasOrganization();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!hasOrg) {
      setShow(false);
      return;
    }
    let alive = true;
    api
      .planOverview()
      .then((data) => {
        if (!alive) return;
        setShow(
          Boolean(
            data.capabilities.can_manage_project_work ||
              data.capabilities.can_view_department_work ||
              (data.lead_department_ids?.length ?? 0),
          ),
        );
      })
      .catch(() => {
        if (alive) setShow(false);
      });
    return () => {
      alive = false;
    };
  }, [hasOrg]);

  return hasOrg && show;
}
