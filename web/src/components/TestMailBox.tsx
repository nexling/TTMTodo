import { type FormEvent, useState } from "react";
import { api } from "../api";

type Props = {
  defaultEmail?: string;
};

export default function TestMailBox({ defaultEmail = "" }: Props) {
  const [email, setEmail] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function send(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const result = await api.sendTestMail(email.trim());
      setMsg(`Test email sent to ${result.to}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send test email");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Test email</h2>
      <p className="hint">
        Send a test message through the server SMTP settings used for plan due-date reminders.
      </p>
      {err ? <p className="error">{err}</p> : null}
      {msg ? <p className="hint">{msg}</p> : null}
      <form onSubmit={(e) => void send(e)}>
        <div className="field">
          <label>To</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send test email"}
        </button>
      </form>
    </section>
  );
}
