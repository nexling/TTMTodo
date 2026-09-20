import { type FormEvent, useState } from "react";
import { api } from "../api";

type Props = {
  mode: "login" | "setup";
  onDone: () => Promise<void> | void;
  error?: string;
};

export default function Gate({ mode, onDone, error: initialError }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError || "");
  const [busy, setBusy] = useState(false);
  const setup = mode === "setup";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (setup) await api.setup(username, password);
      else await api.login(username, password);
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={(e) => void submit(e)}>
        <h1 className="mark">
          TTM-<span>Todo</span>
        </h1>
        <p className="lede">
          {setup
            ? "Create the first account for this machine."
            : "Sign in to dump tasks, photos, and later sort them into buckets."}
        </p>
        {error ? <p className="error">{error}</p> : null}
        <div className="field">
          <label htmlFor="user">Username</label>
          <input
            id="user"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pass">Password</label>
          <input
            id="pass"
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={setup ? 8 : 1}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Working…" : setup ? "Create inbox" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
