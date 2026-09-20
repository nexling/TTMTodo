import { useEffect, useState } from "react";
import { api } from "./api";

export function useDepartmentWorkNav() {
  const [show, setShow] = useState(false);

  useEffect(() => {
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
  }, []);

  return show;
}
