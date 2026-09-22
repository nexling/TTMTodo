import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  type Membership,
  type PlanDepartment,
  type PlanOverview,
  type PlanProject,
  type PlanTemplate,
} from "../api";
import ColorPicker, { COLOR_PALETTE } from "../components/ColorPicker";
import OrgSidebar from "../components/OrgSidebar";
import { isoWeekMeta, startOfISOWeek, type ScheduleDirection } from "../planZoom";

function memberLabel(row: Membership): string {
  const user = row.user;
  return user?.name || user?.email || user?.username || row.user_id;
}

function currentWeekValue(): string {
  const meta = isoWeekMeta(startOfISOWeek(new Date()));
  return `${meta.year}-W${String(meta.week).padStart(2, "0")}`;
}

function currentDateValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function Org() {
  const navigate = useNavigate();
  const [data, setData] = useState<PlanOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [scheduleDirection, setScheduleDirection] = useState<ScheduleDirection>("forward");
  const [startWeek, setStartWeek] = useState(currentWeekValue);
  const [deliveryOn, setDeliveryOn] = useState(currentDateValue);
  const [deptName, setDeptName] = useState("");
  const [deptColor, setDeptColor] = useState(COLOR_PALETTE[2]);
  const [templateName, setTemplateName] = useState("");

  const admin = Boolean(data?.capabilities.can_manage_plan);

  async function load() {
    setError("");
    try {
      setData(await api.planOverview());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load organization plan");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const membersById = useMemo(() => {
    const map = new Map<string, Membership>();
    for (const row of data?.members ?? []) map.set(row.user_id, row);
    return map;
  }, [data]);

  async function switchOrg(organizationId: string) {
    setBusy(true);
    setError("");
    try {
      await api.switchOrg(organizationId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch organization");
    } finally {
      setBusy(false);
    }
  }

  async function addProject(e: FormEvent) {
    e.preventDefault();
    const name = projectName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const project = await api.createPlanProject({
        name,
        template_id: templateId || null,
        schedule_direction: templateId ? scheduleDirection : null,
        start_week: templateId && scheduleDirection === "forward" ? startWeek : null,
        delivery_on: templateId && scheduleDirection === "backward" ? deliveryOn : null,
      });
      setProjectName("");
      setTemplateId("");
      setScheduleDirection("forward");
      navigate(`/org/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  }

  async function addDepartment(e: FormEvent) {
    e.preventDefault();
    const name = deptName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      await api.createDepartment(name, deptColor);
      setDeptName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create department");
    } finally {
      setBusy(false);
    }
  }

  async function savePersonDepts(userId: string, departmentId: string, checked: boolean) {
    const memberOf = (data?.departments ?? [])
      .filter((dept) => (checked ? dept.id === departmentId || dept.member_ids.includes(userId) : dept.id !== departmentId && dept.member_ids.includes(userId)))
      .map((dept) => dept.id);
    const leadOf = (data?.departments ?? [])
      .filter((dept) => memberOf.includes(dept.id) && (dept.lead_ids ?? []).includes(userId) && !(dept.id === departmentId && !checked))
      .map((dept) => dept.id);
    setError("");
    try {
      await api.setPersonDepartments(userId, memberOf, leadOf);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update departments");
    }
  }

  async function savePersonLead(userId: string, departmentId: string, checked: boolean) {
    const memberOf = Array.from(
      new Set(
        (data?.departments ?? [])
          .filter((dept) => dept.member_ids.includes(userId) || (checked && dept.id === departmentId))
          .map((dept) => dept.id),
      ),
    );
    const leadOf = Array.from(
      new Set(
        (data?.departments ?? [])
          .filter((dept) => (checked ? dept.id === departmentId || (dept.lead_ids ?? []).includes(userId) : dept.id !== departmentId && (dept.lead_ids ?? []).includes(userId)))
          .map((dept) => dept.id)
          .filter((id) => memberOf.includes(id)),
      ),
    );
    setError("");
    try {
      await api.setPersonDepartments(userId, memberOf, leadOf);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update department lead");
    }
  }

  async function saveDepartment(
    dept: PlanDepartment,
    body: { name?: string; color?: string; member_ids?: string[]; lead_ids?: string[] },
  ) {
    setError("");
    try {
      await api.updateDepartment(dept.id, body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update department");
    }
  }

  async function saveProject(project: PlanProject, name: string) {
    setError("");
    try {
      await api.updatePlanProject(project.id, { name });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename project");
    }
  }

  async function removeDepartment(dept: PlanDepartment) {
    if (!confirm(`Delete department “${dept.name}”?`)) return;
    setError("");
    try {
      await api.deleteDepartment(dept.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete department");
    }
  }

  async function addTemplate(e: FormEvent) {
    e.preventDefault();
    const name = templateName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const created = await api.createPlanTemplate(name);
      setTemplateName("");
      navigate(`/org/templates/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create template");
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate(template: PlanTemplate) {
    if (!confirm(`Delete template “${template.name}”?`)) return;
    setError("");
    try {
      await api.deletePlanTemplate(template.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete template");
    }
  }

  async function removeProject(id: string, name: string) {
    if (!confirm(`Delete project “${name}”?`)) return;
    setError("");
    try {
      await api.deletePlanProject(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete project");
    }
  }

  return (
    <div className="shell">
      <OrgSidebar active="org" />
      <main className="main">
        <div className="main-head">
            <h1>Organization</h1>
            {data?.capabilities.can_manage_project_work ||
            data?.capabilities.can_view_department_work ||
            (data?.lead_department_ids?.length ?? 0) ? (
              <p className="hint" style={{ margin: "4px 0 0" }}>
                <Link to="/org/departments">Department work</Link> lists every task in your departments across projects.
              </p>
            ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        {!data ? (
          <p className="hint">Loading…</p>
        ) : (
          <>
            <section className="panel">
              <div className="token-row">
                <div>
                  <h2 style={{ margin: 0 }}>{data.organization.name}</h2>
                  <p className="hint" style={{ margin: "6px 0 0" }}>
                    Projects, departments, and templates for this organization.
                  </p>
                </div>
                {data.organizations.length > 1 ? (
                  <select
                    className="sort-select"
                    value={data.organization.id}
                    disabled={busy}
                    aria-label="Active organization"
                    onChange={(e) => void switchOrg(e.target.value)}
                  >
                    {data.organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </section>

            <section className="panel">
              <h2>Projects</h2>
              {admin ? (
                <form className="composer-row" onSubmit={(e) => void addProject(e)} style={{ marginBottom: 16 }}>
                  <input
                    placeholder="Project name"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    maxLength={120}
                  />
                  <select
                    value={templateId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setTemplateId(nextId);
                      const template = data.templates.find((row) => row.id === nextId);
                      setScheduleDirection(template?.schedule_direction === "backward" ? "backward" : "forward");
                    }}
                    aria-label="Template"
                  >
                    <option value="">No template</option>
                    {data.templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                  {templateId ? (
                    <>
                      <div className="plan-zoom" role="group" aria-label="Schedule from">
                        <button
                          className={`btn ghost small${scheduleDirection === "forward" ? " on" : ""}`}
                          type="button"
                          onClick={() => setScheduleDirection("forward")}
                        >
                          From start
                        </button>
                        <button
                          className={`btn ghost small${scheduleDirection === "backward" ? " on" : ""}`}
                          type="button"
                          onClick={() => setScheduleDirection("backward")}
                        >
                          From delivery
                        </button>
                      </div>
                      {scheduleDirection === "backward" ? (
                        <input
                          type="date"
                          value={deliveryOn}
                          onChange={(e) => setDeliveryOn(e.target.value)}
                          aria-label="Delivery date"
                        />
                      ) : (
                        <input
                          type="week"
                          value={startWeek}
                          onChange={(e) => setStartWeek(e.target.value)}
                          aria-label="Start week"
                        />
                      )}
                    </>
                  ) : null}
                  <button className="btn" type="submit" disabled={busy}>
                    New project
                  </button>
                </form>
              ) : (
                <p className="hint">Ask an admin to create a project.</p>
              )}
              {data.projects.length === 0 ? (
                <p className="hint">No projects yet.</p>
              ) : (
                <div className="plan-cards">
                  {data.projects.map((project) => (
                    <div className="plan-card" key={project.id}>
                      <div className="plan-card-main">
                        {admin ? (
                          <input
                            defaultValue={project.name}
                            maxLength={120}
                            aria-label={`${project.name} name`}
                            onBlur={(e) => {
                              const name = e.target.value.trim();
                              if (name && name !== project.name) void saveProject(project, name);
                              else e.target.value = project.name;
                            }}
                          />
                        ) : (
                          <Link to={`/org/projects/${project.id}`}>
                            <strong>{project.name}</strong>
                          </Link>
                        )}
                        <span className="hint">{project.task_count || 0} tasks</span>
                      </div>
                      <div className="composer-row">
                        <Link className="btn ghost small" to={`/org/projects/${project.id}`}>
                          Open
                        </Link>
                        {admin ? (
                          <button className="btn ghost small" type="button" onClick={() => void removeProject(project.id, project.name)}>
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {admin ? (
              <section className="panel">
                <h2>Departments</h2>
                <form className="composer-row" onSubmit={(e) => void addDepartment(e)} style={{ marginBottom: 16 }}>
                  <input
                    placeholder="Department name"
                    value={deptName}
                    onChange={(e) => setDeptName(e.target.value)}
                    maxLength={80}
                  />
                  <ColorPicker value={deptColor} onChange={setDeptColor} />
                  <button className="btn" type="submit" disabled={busy}>
                    Add
                  </button>
                </form>
                {data.departments.length === 0 ? <p className="hint">Add departments to use as rows on the board.</p> : null}
                {data.departments.map((dept) => (
                  <div className="token-row" key={dept.id}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flex: 1, minWidth: 0 }}>
                      <input
                        defaultValue={dept.name}
                        maxLength={80}
                        aria-label={`${dept.name} name`}
                        onBlur={(e) => {
                          const name = e.target.value.trim();
                          if (name && name !== dept.name) void saveDepartment(dept, { name });
                        }}
                      />
                      <ColorPicker
                        value={dept.color}
                        onChange={(color) => {
                          if (color !== dept.color) void saveDepartment(dept, { color });
                        }}
                      />
                    </div>
                    <button className="btn ghost small" type="button" onClick={() => void removeDepartment(dept)}>
                      Delete
                    </button>
                  </div>
                ))}
              </section>
            ) : (
              <section className="panel">
                <h2>Departments</h2>
                {data.departments.map((dept) => (
                  <div className="token-row" key={dept.id}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span className="dot" style={{ background: dept.color }} />
                      <strong>{dept.name}</strong>
                    </div>
                    <span className="hint" style={{ margin: 0 }}>
                      {dept.member_ids
                        .map((id) => {
                          const label = memberLabel(membersById.get(id) || ({ user_id: id } as Membership));
                          return (dept.lead_ids ?? []).includes(id) ? `${label} (lead)` : label;
                        })
                        .join(", ") || "No people yet"}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {admin && data.members.length ? (
              <section className="panel">
                <h2>People</h2>
                <p className="hint">Assign each person to one or more departments, and mark who leads them.</p>
                {data.members.map((row) => (
                  <div className="token-row dept-assign" key={row.user_id}>
                    <strong style={{ minWidth: 140 }}>{memberLabel(row)}</strong>
                    <div className="dept-people">
                      {data.departments.map((dept) => (
                        <label key={dept.id}>
                          <input
                            type="checkbox"
                            checked={dept.member_ids.includes(row.user_id)}
                            onChange={(e) => void savePersonDepts(row.user_id, dept.id, e.target.checked)}
                          />
                          {dept.name}
                          <span className="dept-lead">
                            <input
                              type="checkbox"
                              checked={(dept.lead_ids ?? []).includes(row.user_id)}
                              disabled={!dept.member_ids.includes(row.user_id) && !(dept.lead_ids ?? []).includes(row.user_id)}
                              onChange={(e) => void savePersonLead(row.user_id, dept.id, e.target.checked)}
                            />
                            Lead
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            ) : null}

            {admin ? (
              <section className="panel">
                <h2>Templates</h2>
                <form className="composer-row" onSubmit={(e) => void addTemplate(e)} style={{ marginBottom: 16 }}>
                  <input
                    placeholder="Template name"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    maxLength={120}
                  />
                  <button className="btn" type="submit" disabled={busy}>
                    New template
                  </button>
                </form>
                {data.templates.map((template) => (
                  <div className="token-row" key={template.id}>
                    <div>
                      <strong>{template.name}</strong>
                      <p className="hint" style={{ margin: "4px 0 0" }}>
                        {template.task_count} tasks
                      </p>
                    </div>
                    <div className="composer-row">
                      <Link className="btn ghost small" to={`/org/templates/${template.id}`}>
                        Edit
                      </Link>
                      <button className="btn ghost small" type="button" onClick={() => void removeTemplate(template)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
