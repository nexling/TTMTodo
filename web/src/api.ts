export type User = {
  id: string;
  username: string;
  email?: string | null;
  name?: string | null;
  auth_provider_id?: string | null;
  is_admin?: boolean;
};

export type LicenseAccess = {
  is_licensed: boolean;
  source: string | null;
  reason: string | null;
  seat_consumed: boolean;
  organization_license_status: string;
  organization_license: License | null;
  individual_license: License | null;
};

export type License = {
  id: string;
  license_type: string;
  organization_id: string | null;
  user_id: string | null;
  assigned_email: string | null;
  seat_count: number;
  expires_at: string | null;
  expires_on: string | null;
  is_active: boolean;
  status: string;
  user?: User | null;
  organization?: Organization | null;
};

export type Organization = {
  id: string;
  name: string;
  owner_user_id: string | null;
  created_at: string | null;
};

export type Membership = {
  id: string;
  user_id: string;
  organization_id: string;
  role: string;
  status: string;
  capabilities: {
    is_owner: boolean;
    can_manage_organization: boolean;
    can_manage_members: boolean;
    can_invite_members: boolean;
    can_manage_plan?: boolean;
    can_manage_project_work?: boolean;
    can_view_department_work?: boolean;
  };
  user?: User;
  organization?: Organization;
  license_access?: LicenseAccess;
};

export type Invitation = {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  status: string;
  created_at: string | null;
};

export type LicenseSummary = {
  status: string;
  seat_count: number;
  seats_used: number;
  available_seats: number;
  members_with_individual_license: number;
  pending_invitation_seats: number;
  active_member_count: number;
  pending_invitation_count: number;
  license: License | null;
};

export type OrgSettings = {
  organization: Organization;
  membership: Membership;
  members: Membership[];
  pending_invitations: Invitation[];
  invitable_roles: string[];
  license_summary: LicenseSummary;
  capabilities: Membership["capabilities"];
};

export type PlanDepartment = {
  id: string;
  organization_id: string;
  name: string;
  color: string;
  sort_order: number;
  member_ids: string[];
  lead_ids: string[];
};

export type PlanTemplateTask = {
  id: string;
  title: string;
  notes: string | null;
  department_id: string | null;
  day_offset: number;
  week_offset: number;
  notify_days_before: number | null;
  sort_order: number;
  predecessor_ids: string[];
};

export type PlanTemplate = {
  id: string;
  organization_id: string;
  name: string;
  schedule_direction: "forward" | "backward";
  created_at: string | null;
  task_count: number;
  tasks: PlanTemplateTask[];
};

export type PlanProject = {
  id: string;
  organization_id: string;
  name: string;
  created_at: string | null;
  task_count?: number | null;
};

export type PlanSubtask = {
  id: string;
  title: string;
  status: "open" | "done";
  assignee_user_id: string | null;
  assignee: User | null;
  can_complete: boolean;
  can_manage?: boolean;
};

export type PlanTask = {
  id: string;
  project_id: string;
  title: string;
  notes: string | null;
  department_id: string | null;
  assignee_user_id: string | null;
  assignee: User | null;
  due_on: string;
  week_start: string;
  week_label: string;
  notify_days_before: number | null;
  status: "open" | "done";
  sort_order: number;
  completed_at: string | null;
  predecessor_ids: string[];
  blocked: boolean;
  can_complete: boolean;
  can_manage?: boolean;
  item_id: string | null;
  project_name?: string | null;
  attachments?: Attachment[];
  parent_id?: string | null;
  subtasks?: PlanSubtask[];
  progress?: number | null;
};

export type PlanOverview = {
  organization: Organization;
  capabilities: Membership["capabilities"];
  organizations: { id: string; name: string; role?: string }[];
  members: Membership[];
  departments: PlanDepartment[];
  templates: PlanTemplate[];
  projects: PlanProject[];
  my_department_ids?: string[];
  lead_department_ids?: string[];
};

export type PlanMyTodos = {
  capabilities: Membership["capabilities"];
  lead_department_ids: string[];
  viewer_id: string;
  members: Membership[];
  departments: PlanDepartment[];
  tasks: PlanTask[];
};

export type PlanDepartmentWork = {
  capabilities: Membership["capabilities"];
  my_department_ids: string[];
  lead_department_ids?: string[];
  members: Membership[];
  departments: PlanDepartment[];
  projects: PlanProject[];
  tasks: PlanTask[];
};

export type PlanRelatedTask = {
  id: string;
  title: string;
  due_on: string;
  status: "open" | "done";
};

export type PlanRelated = {
  upstream: PlanRelatedTask[];
  following: PlanRelatedTask[];
};

export type PlanBoard = {
  project: PlanProject;
  capabilities: Membership["capabilities"];
  members: Membership[];
  departments: PlanDepartment[];
  lead_department_ids?: string[];
  tasks: PlanTask[];
};

export type NotificationCategory = {
  id: string;
  label: string;
  project_scoped: boolean;
};

export type NotificationPreferences = {
  categories: NotificationCategory[];
  global: Record<string, boolean>;
  projects: { id: string; name: string; prefs: Record<string, boolean | null> }[];
};

export type MailStatus = {
  mail_sent?: boolean;
  mail_error?: string | null;
};

export function mailFailureHint(result: MailStatus): string {
  return result.mail_error ? " The invitation email could not be sent." : "";
}

export type AdminContext = {
  known_users: User[];
  individual_licenses: License[];
  organizations: {
    organization: Organization;
    owner: User | null;
    pending_owner_email?: string | null;
    license_summary: LicenseSummary;
  }[];
};

export type AuthStatus = {
  setup_required: boolean;
  auth0_enabled: boolean;
  user: User | null;
  is_site_admin: boolean;
  licensed: boolean;
  license_access: LicenseAccess | null;
  organization: Organization | null;
  membership: Membership | null;
  organizations: Membership[];
  capabilities: Membership["capabilities"] | null;
  public_url: string;
  login_url: string;
  logout_url: string;
};

export type Bucket = {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  is_inbox: boolean;
  parent_id: string | null;
  organization_id: string | null;
  plan_project_id: string | null;
  locked: boolean;
  open_count: number;
};

export type Attachment = {
  id: string;
  original_name: string;
  mime_type: string;
  size: number;
  url: string;
};

export type Item = {
  id: string;
  bucket_id: string;
  parent_id: string | null;
  title: string | null;
  notes: string | null;
  status: "open" | "done";
  source: string;
  created_at: string;
  completed_at: string | null;
  due_at: string | null;
  reminder_lead_minutes: number | null;
  remind_at: string | null;
  recur_interval: number | null;
  recur_unit: "day" | "week" | "month" | "year" | null;
  ocr_text: string | null;
  ai_priority: number | null;
  ai_summary: string | null;
  sort_order: number;
  plan_task_id?: string | null;
  attachments: Attachment[];
  subtasks: Item[];
};

export type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  token?: string | null;
};

export type GoogleList = {
  id: string;
  title: string;
  selected: boolean;
};

export type GoogleSourceStatus = {
  configured: boolean;
  connected: boolean;
  label: string;
  imported: number;
  skipped: number;
  error: string | null;
  lists: GoogleList[];
  watch_all?: boolean;
};

export type GoogleStatus = {
  tasks: GoogleSourceStatus;
  keep: GoogleSourceStatus;
  last_at: string | null;
  last_ok: boolean | null;
  error: string | null;
};

export type RemarkableStatus = {
  configured: boolean;
  host: string;
  user: string;
  port: number;
  folder: string;
  out_folder: string;
  key_path: string;
  reachable: boolean | null;
  last_at: string | null;
  last_ok: boolean | null;
  imported: number;
  updated: number;
  skipped: number;
  skipped_existing: number;
  skipped_no_file: number;
  skipped_no_image: number;
  error: string | null;
};

export type OutlookCalendar = {
  id: string;
  name: string;
  selected: boolean;
  color: string;
};

export type OutlookAccount = {
  id: string;
  label: string;
  error: string | null;
  calendars: OutlookCalendar[];
};

export type OutlookStatus = {
  configured: boolean;
  connected: boolean;
  accounts: OutlookAccount[];
};

export type OutlookEvent = {
  id: string;
  calendar_id: string;
  calendar_name: string;
  color: string;
  subject: string;
  start: string;
  end: string;
  is_all_day: boolean;
  location: string;
  web_link: string | null;
};

export type IcalFeed = {
  id: string;
  label: string;
  url: string;
  color: string;
  error: string | null;
  last_fetch: number;
};

export type IcalStatus = {
  feeds: IcalFeed[];
};

export type CalendarExportStatus = {
  enabled: boolean;
  path: string | null;
};

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) {
      return data.detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join(", ");
    }
  } catch {
    /* ignore */
  }
  return res.statusText || "Request failed";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) {
    throw new Error(await parseError(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  status: () => request<AuthStatus>("/api/auth/status"),
  setup: (username: string, password: string) =>
    request<User>("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<User>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean; logout_url?: string }>("/api/auth/logout", { method: "POST" }),
  orgSettings: () => request<OrgSettings>("/api/orgs/settings"),
  switchOrg: (organization_id: string) =>
    request<unknown>("/api/orgs/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id }),
    }),
  renameOrg: (name: string) =>
    request<Organization>("/api/orgs/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  inviteOrg: (email: string, role: string) =>
    request<{ membership: Membership | null; invitation: Invitation | null } & MailStatus>("/api/orgs/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    }),
  updateMemberRole: (membershipId: string, role: string) =>
    request<Membership>(`/api/orgs/memberships/${membershipId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    }),
  kickMember: (membershipId: string) =>
    request<{ ok: boolean }>(`/api/orgs/memberships/${membershipId}/kick`, { method: "POST" }),
  revokeInvite: (invitationId: string) =>
    request<{ ok: boolean }>(`/api/orgs/invitations/${invitationId}/revoke`, { method: "POST" }),
  adminContext: () => request<AdminContext>("/api/admin"),
  createOrganization: (name: string, owner_email: string) =>
    request<AdminContext["organizations"][number] & MailStatus>("/api/admin/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, owner_email }),
    }),
  saveIndividualLicense: (email: string, expires_at: string, license_id?: string) =>
    request<License & MailStatus>("/api/admin/licenses/individual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, expires_at, license_id: license_id || null }),
    }),
  saveOrganizationLicense: (organization_id: string, seat_count: number, expires_at: string, license_id?: string) =>
    request<License>("/api/admin/licenses/organization", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id, seat_count, expires_at, license_id: license_id || null }),
    }),
  deleteLicense: (licenseId: string) =>
    request<{ ok: boolean }>(`/api/admin/licenses/${licenseId}/delete`, { method: "POST" }),
  sendTestMail: (email: string) =>
    request<{ ok: boolean; to: string }>("/api/admin/test-mail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  buckets: () => request<Bucket[]>("/api/buckets"),
  createBucket: (name: string, color: string, parentId?: string | null) =>
    request<Bucket>("/api/buckets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color, parent_id: parentId || null }),
    }),
  updateBucket: (id: string, body: { name?: string; color?: string; parent_id?: string | null }) =>
    request<Bucket>(`/api/buckets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  reorderBuckets: (ids: string[]) =>
    request<{ ok: boolean }>("/api/buckets/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  deleteBucket: (id: string) =>
    request<{ ok: boolean }>(`/api/buckets/${id}`, { method: "DELETE" }),
  items: (
    bucketId: string | undefined,
    includeDone: boolean,
    completedSince?: string,
    completedBefore?: string,
    includeDescendants?: boolean,
  ) => {
    const params = new URLSearchParams();
    if (completedSince) {
      params.set("completed_since", completedSince);
      if (completedBefore) params.set("completed_before", completedBefore);
    } else {
      params.set("include_done", String(includeDone));
      if (bucketId) params.set("bucket_id", bucketId);
      if (includeDescendants) params.set("include_descendants", "true");
    }
    return request<Item[]>(`/api/items?${params}`);
  },
  createItem: (form: FormData) =>
    request<Item>("/api/items", { method: "POST", body: form }),
  reorderItems: (ids: string[]) =>
    request<{ ok: boolean }>("/api/items/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  patchItem: (
    id: string,
    body: Partial<
      Pick<
        Item,
        "title" | "notes" | "bucket_id" | "parent_id" | "status" | "due_at" | "reminder_lead_minutes" | "remind_at" | "recur_interval" | "recur_unit"
      >
    >,
  ) =>
    request<Item>(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteItem: (id: string) => request<{ ok: boolean }>(`/api/items/${id}`, { method: "DELETE" }),
  addAttachment: (itemId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<Item>(`/api/items/${itemId}/attachments`, { method: "POST", body: form });
  },
  deleteAttachment: (itemId: string, attachmentId: string) =>
    request<{ ok: boolean }>(`/api/items/${itemId}/attachments/${attachmentId}`, {
      method: "DELETE",
    }),
  tokens: () => request<ApiToken[]>("/api/tokens"),
  createToken: (name: string) =>
    request<ApiToken>("/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  revokeToken: (id: string) => request<{ ok: boolean }>(`/api/tokens/${id}`, { method: "DELETE" }),
  remarkableStatus: () => request<RemarkableStatus>("/api/remarkable"),
  remarkableSave: (body: {
    host: string;
    user: string;
    port: number;
    folder: string;
    out_folder: string;
    key_path: string;
    private_key: string;
  }) =>
    request<RemarkableStatus>("/api/remarkable/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  remarkableSync: () =>
    request<RemarkableStatus>("/api/remarkable/sync", { method: "POST" }),
  sendToRemarkable: (itemId: string) =>
    request<{ ok: boolean; method: string; document_id: string | null }>(
      `/api/items/${itemId}/remarkable`,
      { method: "POST" },
    ),
  googleStatus: (refresh = false) =>
    request<GoogleStatus>(`/api/google?refresh=${refresh ? "true" : "false"}`),
  googleSync: () => request<GoogleStatus>("/api/google/sync", { method: "POST" }),
  googleDisconnectTasks: () =>
    request<GoogleStatus>("/api/google/tasks/disconnect", { method: "POST" }),
  googleSetTasksList: (list_id: string) =>
    request<GoogleStatus>("/api/google/tasks/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list_id }),
    }),
  googleConnectKeep: (email: string, master_token: string) =>
    request<GoogleStatus>("/api/google/keep/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, master_token }),
    }),
  googleDisconnectKeep: () =>
    request<GoogleStatus>("/api/google/keep/disconnect", { method: "POST" }),
  googleSetKeepLists: (note_ids: string[], watch_all = false) =>
    request<GoogleStatus>("/api/google/keep/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note_ids, watch_all }),
    }),
  outlookStatus: (refresh = false) =>
    request<OutlookStatus>(`/api/outlook?refresh=${refresh ? "true" : "false"}`),
  outlookDisconnect: (account_id = "") =>
    request<OutlookStatus>("/api/outlook/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id }),
    }),
  outlookSetCalendars: (account_id: string, calendar_ids: string[], calendar_colors?: Record<string, string>) =>
    request<OutlookStatus>("/api/outlook/calendars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id, calendar_ids, calendar_colors }),
    }),
  outlookEvents: (start: string, end: string) => {
    const params = new URLSearchParams({ start, end });
    return request<OutlookEvent[]>(`/api/outlook/events?${params}`);
  },
  icalStatus: () => request<IcalStatus>("/api/ical"),
  icalAddFeed: (body: { label: string; url: string; color: string }) =>
    request<IcalStatus>("/api/ical/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  icalPatchFeed: (id: string, body: { label?: string; url?: string; color?: string }) =>
    request<IcalStatus>(`/api/ical/feeds/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  icalDeleteFeed: (id: string) =>
    request<IcalStatus>(`/api/ical/feeds/${id}`, { method: "DELETE" }),
  icalEvents: (start: string, end: string) => {
    const params = new URLSearchParams({ start, end });
    return request<OutlookEvent[]>(`/api/ical/events?${params}`);
  },
  calendarExportStatus: () => request<CalendarExportStatus>("/api/calendar/export"),
  calendarExportEnable: () =>
    request<CalendarExportStatus>("/api/calendar/export", { method: "POST" }),
  calendarExportRegenerate: () =>
    request<CalendarExportStatus>("/api/calendar/export/regenerate", { method: "POST" }),
  calendarExportDisable: () =>
    request<CalendarExportStatus>("/api/calendar/export", { method: "DELETE" }),
  pushVapid: () => request<{ publicKey: string }>("/api/push/vapid"),
  pushSubscribe: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: boolean }>("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  pushUnsubscribe: (endpoint: string) =>
    request<{ ok: boolean }>("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }),
  pushTest: () =>
    request<{ delivered: number; devices: number }>("/api/push/test", { method: "POST" }),
  planOverview: () => request<PlanOverview>("/api/plan/overview"),
  createDepartment: (name: string, color: string) =>
    request<PlanDepartment>("/api/plan/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color }),
    }),
  updateDepartment: (
    id: string,
    body: { name?: string; color?: string; sort_order?: number; member_ids?: string[]; lead_ids?: string[] },
  ) =>
    request<PlanDepartment>(`/api/plan/departments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  reorderDepartments: (ids: string[]) =>
    request<{ ok: boolean }>("/api/plan/departments/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  deleteDepartment: (id: string) =>
    request<{ ok: boolean }>(`/api/plan/departments/${id}`, { method: "DELETE" }),
  setPersonDepartments: (userId: string, department_ids: string[], lead_ids?: string[]) =>
    request<{ ok: boolean; department_ids: string[]; lead_ids: string[] }>(`/api/plan/people/${userId}/departments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ department_ids, lead_ids }),
    }),
  departmentWork: () => request<PlanDepartmentWork>("/api/plan/department-work"),
  myTodos: (scope: "mine" | "people" | "department") =>
    request<PlanMyTodos>(`/api/plan/my-todos?scope=${scope}`),
  createPlanTemplate: (name: string) =>
    request<PlanTemplate>("/api/plan/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  getPlanTemplate: (id: string) => request<PlanTemplate>(`/api/plan/templates/${id}`),
  savePlanTemplate: (
    id: string,
    body: {
      name?: string;
      schedule_direction?: "forward" | "backward";
      tasks: {
        id?: string | null;
        title: string;
        notes?: string | null;
        department_id?: string | null;
        day_offset?: number;
        week_offset?: number;
        notify_days_before?: number | null;
        sort_order: number;
        predecessor_ids: string[];
      }[];
    },
  ) =>
    request<PlanTemplate>(`/api/plan/templates/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deletePlanTemplate: (id: string) =>
    request<{ ok: boolean }>(`/api/plan/templates/${id}`, { method: "DELETE" }),
  createPlanProject: (body: {
    name: string;
    template_id?: string | null;
    schedule_direction?: "forward" | "backward" | null;
    start_week?: string | null;
    delivery_on?: string | null;
  }) =>
    request<PlanProject>("/api/plan/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: body.name,
        template_id: body.template_id || null,
        schedule_direction: body.schedule_direction || null,
        start_week: body.start_week || null,
        delivery_on: body.delivery_on || null,
      }),
    }),
  updatePlanProject: (id: string, body: { name?: string }) =>
    request<PlanProject>(`/api/plan/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deletePlanProject: (id: string) =>
    request<{ ok: boolean }>(`/api/plan/projects/${id}`, { method: "DELETE" }),
  getPlanProject: (id: string) => request<PlanBoard>(`/api/plan/projects/${id}`),
  createPlanTask: (
    projectId: string,
    body: {
      title: string;
      notes?: string | null;
      department_id?: string | null;
      assignee_user_id?: string | null;
      due_on?: string;
      week_start?: string;
      notify_days_before?: number | null;
      predecessor_ids?: string[];
      parent_id?: string | null;
    },
  ) =>
    request<PlanTask>(`/api/plan/projects/${projectId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  updatePlanTask: (
    id: string,
    body: {
      title?: string;
      notes?: string | null;
      department_id?: string | null;
      assignee_user_id?: string | null;
      due_on?: string;
      week_start?: string;
      notify_days_before?: number | null;
      status?: "open" | "done";
      predecessor_ids?: string[];
    },
  ) =>
    request<PlanTask>(`/api/plan/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  movePlanTask: (
    id: string,
    body: { department_id?: string | null; due_on?: string; week_start?: string; before_id?: string | null },
  ) =>
    request<PlanTask>(`/api/plan/tasks/${id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  planTaskRelated: (id: string) => request<PlanRelated>(`/api/plan/tasks/${id}/related`),
  reschedulePlanTask: (
    id: string,
    body: {
      due_on: string;
      shift_upstream?: boolean;
      shift_following?: boolean;
      department_id?: string | null;
      before_id?: string | null;
      due_at?: string | null;
    },
  ) =>
    request<PlanTask>(`/api/plan/tasks/${id}/reschedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deletePlanTask: (id: string) => request<{ ok: boolean }>(`/api/plan/tasks/${id}`, { method: "DELETE" }),
  addPlanTaskAttachment: (taskId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<PlanTask>(`/api/plan/tasks/${taskId}/attachments`, { method: "POST", body: form });
  },
  deletePlanTaskAttachment: (taskId: string, attachmentId: string) =>
    request<PlanTask>(`/api/plan/tasks/${taskId}/attachments/${attachmentId}`, { method: "DELETE" }),
  notificationPreferences: () => request<NotificationPreferences>("/api/notifications/preferences"),
  patchNotificationPreferences: (body: {
    category: string;
    enabled: boolean | null;
    project_id?: string | null;
  }) =>
    request<NotificationPreferences>("/api/notifications/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
};
