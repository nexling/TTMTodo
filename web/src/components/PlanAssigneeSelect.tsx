import type { Membership } from "../api";

export function memberLabel(row: Membership | undefined): string {
  const user = row?.user;
  return user?.name || user?.email || user?.username || "Unassigned";
}

export function PlanAssigneeSelect(props: {
  value: string;
  onChange: (userId: string) => void;
  members: Membership[];
  departmentMemberIds: Iterable<string>;
  disabled?: boolean;
}) {
  const { value, onChange, members, disabled } = props;
  const inDeptIds = new Set(props.departmentMemberIds);
  const inDept = members.filter((row) => inDeptIds.has(row.user_id));
  const outDept = members.filter((row) => !inDeptIds.has(row.user_id));
  const showSplit = inDept.length > 0 && outDept.length > 0;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Nobody yet</option>
      {inDept.map((row) => (
        <option key={row.user_id} value={row.user_id}>
          {memberLabel(row)}
        </option>
      ))}
      {showSplit ? (
        <option value="__dept-split" disabled>
          ----------
        </option>
      ) : null}
      {outDept.map((row) => (
        <option key={row.user_id} value={row.user_id}>
          {memberLabel(row)}
        </option>
      ))}
    </select>
  );
}
