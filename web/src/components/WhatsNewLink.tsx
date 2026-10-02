import { Link } from "react-router-dom";
import { hasUnseenChangelog } from "../changelog";

export default function WhatsNewLink({
  onNavigate,
  className = "nav-btn",
}: {
  onNavigate?: () => void;
  className?: string;
}) {
  const unseen = hasUnseenChangelog();
  return (
    <Link
      className={className}
      to="/changelog"
      onClick={onNavigate}
      aria-label={unseen ? "What's new (new updates)" : "What's new"}
    >
      What's new
      {unseen ? <span className="whats-new-dot" aria-hidden="true" /> : null}
    </Link>
  );
}
