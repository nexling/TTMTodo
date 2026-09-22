import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, type AuthStatus } from "./api";
import { startLive, stopLive } from "./live";
import Board from "./pages/Board";
import Calendar from "./pages/Calendar";
import Gate from "./pages/Gate";
import Org from "./pages/Org";
import DepartmentWork from "./pages/DepartmentWork";
import PlanBoard from "./pages/PlanBoard";
import PlanTemplatePage from "./pages/PlanTemplate";
import Settings from "./pages/Settings";
import Unlicensed from "./pages/Unlicensed";
import WebsiteAdmin from "./pages/WebsiteAdmin";

function authErrorMessage() {
  const raw = new URLSearchParams(window.location.search).get("error");
  if (!raw) return "";
  if (raw === "auth0") return "Auth0 sign-in failed. Try again.";
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

function SignInPrompt({ loginUrl, error }: { loginUrl: string; error: string }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <h1 className="mark">
          TTM-<span>Todo</span>
        </h1>
        {error ? <p className="error">{error}</p> : <p className="lede">Sign in to open your inbox.</p>}
        <p>
          <a className="btn" href={loginUrl || "/login"}>
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}

function AuthRoutes({
  status,
  refresh,
}: {
  status: AuthStatus;
  refresh: () => Promise<void>;
}) {
  const location = useLocation();
  const displayName = status.user?.name || status.user?.email || status.user?.username || "";
  const bounceError = authErrorMessage();
  const canAutoLogin =
    status.auth0_enabled &&
    !status.user &&
    location.pathname !== "/login" &&
    location.pathname !== "/callback" &&
    !bounceError;

  useEffect(() => {
    if (canAutoLogin) {
      window.location.href = status.login_url || "/login";
    }
  }, [canAutoLogin, status.login_url]);

  if (status.setup_required) {
    return (
      <Routes>
        <Route path="/setup" element={<Gate mode="setup" onDone={refresh} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!status.user) {
    if (status.auth0_enabled) {
      return (
        <Routes>
          <Route
            path="*"
            element={
              canAutoLogin ? (
                <div className="gate">
                  <p className="lede">Redirecting to sign in…</p>
                </div>
              ) : (
                <SignInPrompt loginUrl={status.login_url} error={bounceError} />
              )
            }
          />
        </Routes>
      );
    }
    return (
      <Routes>
        <Route path="/login" element={<Gate mode="login" onDone={refresh} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const admin = (
    <WebsiteAdmin
      onLogout={() => {
        window.location.href = status.logout_url;
      }}
    />
  );

  if (!status.licensed) {
    return (
      <Routes>
        {status.is_site_admin ? <Route path="/website-admin" element={admin} /> : null}
        <Route path="*" element={<Unlicensed status={status} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Board />} />
      <Route path="/all" element={<Board />} />
      <Route path="/done" element={<Board />} />
      <Route path="/b/:bucketId" element={<Board />} />
      <Route path="/calendar" element={<Calendar />} />
      <Route path="/org" element={<Org />} />
      <Route path="/org/departments/:departmentId" element={<DepartmentWork />} />
      <Route path="/org/departments" element={<DepartmentWork />} />
      <Route path="/org/projects/:projectId/departments/:departmentId" element={<PlanBoard />} />
      <Route path="/org/projects/:projectId" element={<PlanBoard />} />
      <Route path="/org/templates/:templateId" element={<PlanTemplatePage />} />
      <Route
        path="/settings"
        element={
          <Settings
            username={displayName}
            isSiteAdmin={status.is_site_admin}
            userEmail={status.user?.email || ""}
            publicUrl={status.public_url}
            organizationName={status.organization?.name}
            onLogout={() => {
              window.location.href = status.logout_url;
            }}
          />
        }
      />
      {status.is_site_admin ? <Route path="/website-admin" element={admin} /> : null}
      <Route path="/setup" element={<Navigate to="/" replace />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/unlicensed" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    setError("");
    try {
      setStatus(await api.status());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the server");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (status?.user && status.licensed) startLive();
    else stopLive();
    return () => stopLive();
  }, [status?.user?.id, status?.licensed]);

  if (error && !status) {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1 className="mark">
            TTM-<span>Todo</span>
          </h1>
          <p className="error">{error}</p>
          <button className="btn" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="gate">
        <p className="lede">Opening inbox…</p>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <AuthRoutes status={status} refresh={refresh} />
    </BrowserRouter>
  );
}
