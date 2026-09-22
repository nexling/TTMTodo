import { useEffect, useRef } from "react";
import type { Membership, PlanDepartment, PlanTask } from "./api";

export type DeptMenu = { id: string; x: number; y: number };

export function DepartmentViewMenu({
  menu,
  onOpen,
  onClose,
}: {
  menu: DeptMenu | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!menu) return;
    function close() {
      onCloseRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onContext(e: Event) {
      e.preventDefault();
      close();
    }
    const timer = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", onContext);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div
      className="color-menu"
      style={{
        left: Math.max(12, Math.min(menu.x, window.innerWidth - 180)),
        top: Math.max(12, Math.min(menu.y, window.innerHeight - 80)),
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          const id = menu.id;
          onClose();
          onOpen(id);
        }}
      >
        Department View
      </button>
    </div>
  );
}

export type PlanGridRow = {
  key: string;
  name: string;
  color: string;
  departmentId: string | null;
  /** Omitted on the full board. Null clears the assignee; a user id assigns that person. */
  assigneeUserId?: string | null;
  person: boolean;
  navigable: boolean;
};

function personName(userId: string, members: Membership[], assignee: PlanTask["assignee"]): string {
  const member = members.find((row) => row.user_id === userId);
  const user = member?.user ?? assignee;
  return user?.name || user?.email || user?.username || "Person";
}

export function departmentBoardRows(departments: PlanDepartment[], includeUnassigned: boolean): PlanGridRow[] {
  const rows: PlanGridRow[] = departments.map((dept) => ({
    key: dept.id,
    name: dept.name,
    color: dept.color,
    departmentId: dept.id,
    person: false,
    navigable: true,
  }));
  if (includeUnassigned) {
    rows.push({
      key: "none",
      name: "Unassigned",
      color: "#3a3428",
      departmentId: null,
      person: false,
      navigable: false,
    });
  }
  return rows;
}

export function departmentFocusRows(
  department: PlanDepartment,
  tasks: Pick<PlanTask, "assignee_user_id" | "assignee">[],
  members: Membership[],
): PlanGridRow[] {
  const names = new Map<string, string>();
  for (const task of tasks) {
    const userId = task.assignee_user_id;
    if (!userId || names.has(userId)) continue;
    names.set(userId, personName(userId, members, task.assignee));
  }
  const people = [...names.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }) || a[0].localeCompare(b[0]))
    .map(
      ([userId, name]): PlanGridRow => ({
        key: userId,
        name,
        color: department.color,
        departmentId: department.id,
        assigneeUserId: userId,
        person: true,
        navigable: false,
      }),
    );
  return [
    {
      key: "dept",
      name: department.name,
      color: department.color,
      departmentId: department.id,
      assigneeUserId: null,
      person: false,
      navigable: false,
    },
    ...people,
  ];
}
