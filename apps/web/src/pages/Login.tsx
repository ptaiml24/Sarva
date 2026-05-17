import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { ScreenBackgroundToggle } from "../layout/ScreenBackgroundToggle.js";
import {
  applyScreenBackground,
  getStoredScreenBackground,
  type ScreenBackground,
} from "../layout/screenBackground.js";

export function LoginPage() {
  const { token, login } = useAuth();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "operator">("admin");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [screenBackground, setScreenBackground] = useState<ScreenBackground>(() =>
    getStoredScreenBackground(),
  );

  function onScreenBackgroundChange(value: ScreenBackground): void {
    setScreenBackground(value);
    applyScreenBackground(value);
  }

  if (token) {
    return <Navigate to="/dashboard" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await login(email, role);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap" data-testid="login-page">
      <div className="login-appearance-bar">
        <ScreenBackgroundToggle value={screenBackground} onChange={onScreenBackgroundChange} />
      </div>
      <div className="card" style={{ maxWidth: 400 }}>
        <h1>Sign in</h1>
        <p>Dev JWT — use admin for org changes.</p>
        <form onSubmit={onSubmit}>
          <label>
            Email
            <input
              data-testid="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label style={{ marginTop: "0.75rem" }}>
            Role
            <select data-testid="login-role" value={role} onChange={(e) => setRole(e.target.value as "admin" | "operator")}>
              <option value="admin">admin</option>
              <option value="operator">operator</option>
            </select>
          </label>
          {err ? (
            <p className="err" data-testid="login-error">
              {err}
            </p>
          ) : null}
          <button type="submit" className="primary" disabled={loading} data-testid="login-submit" style={{ marginTop: "1rem" }}>
            {loading ? "…" : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
