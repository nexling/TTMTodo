export function roleLabel(role: string): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "project_manager") return "Project manager";
  return "Member";
}
