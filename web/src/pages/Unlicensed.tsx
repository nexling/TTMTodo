import { Link } from "react-router-dom";
import type { AuthStatus } from "../api";

const REASONS: Record<string, string> = {
  organization_license_missing: "This organization does not have an active license.",
  organization_license_expired: "This organization's license has expired.",
  organization_seat_limit_reached: "This organization has no remaining licensed seats.",
  no_active_membership: "You are not in a licensed organization, and you do not have an individual license.",
};

type Props = {
  status: AuthStatus;
};

export default function Unlicensed({ status }: Props) {
  const reason = status.license_access?.reason || "no_active_membership";
  const message = REASONS[reason] || "Your account is not licensed to use TTM-Todo yet.";
  return (
    <div className="gate">
      <div className="gate-card">
        <h1 className="mark">
          TTM-<span>Todo</span>
        </h1>
        <p className="lede">{message}</p>
        <p className="hint">
          Ask a site admin to assign an individual license to {status.user?.email || "your email"}, or
          an organization license with an open seat.
        </p>
        {status.organization ? (
          <p className="hint">
            Current organization: <span className="mono">{status.organization.name}</span>
          </p>
        ) : null}
        {status.is_site_admin ? (
          <p>
            <Link className="btn" to="/website-admin">
              Open website admin
            </Link>
          </p>
        ) : null}
        <p className="hint">
          <a href={status.logout_url}>Sign out</a>
        </p>
      </div>
    </div>
  );
}
