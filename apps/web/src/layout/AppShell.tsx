import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.js";
import { pageTitleForPath } from "./routeTitles.js";
import { api } from "../api/http.js";
import { ScreenBackgroundToggle } from "./ScreenBackgroundToggle.js";
import {
  applyScreenBackground,
  getStoredScreenBackground,
  type ScreenBackground,
} from "./screenBackground.js";
import "./AppShell.css";

type NavItem = { to: string; label: string; icon?: string; adminOnly?: boolean };

const NAV_MAIN: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: "▣" },
];

const NAV_ORG: NavItem[] = [
  { to: "/organization/guided-setup", label: "Guided setup", icon: "◈" },
  { to: "/organization/business-units", label: "Business units", icon: "⌗" },
  { to: "/organization/teams", label: "Teams", icon: "◎" },
  { to: "/organization/skills-models", label: "Roles & skills", icon: "⚙" },
];

const NAV_WORK: NavItem[] = [
  { to: "/projects", label: "Projects", icon: "◫" },
  { to: "/tasks", label: "Tasks", icon: "▤" },
  { to: "/issues", label: "Issues", icon: "⚠" },
  { to: "/agents", label: "Agents", icon: "◇" },
];

const NAV_SYSTEM: NavItem[] = [
  { to: "/admin", label: "Admin", icon: "⚙", adminOnly: true },
];

type CompanyRow = { id: string; name: string };

function NavItems({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const { role } = useAuth();
  return (
    <>
      {items
        .filter((i) => !i.adminOnly || role === "admin")
        .map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => (isActive ? "active" : "")}
            end={to === "/projects"}
            onClick={onNavigate}
          >
            {icon ? (
              <span className="shell-nav-icon" aria-hidden>
                {icon}
              </span>
            ) : null}
            <span>{label}</span>
          </NavLink>
        ))}
    </>
  );
}

export function AppShell() {
  const { email, logout, role } = useAuth();
  const location = useLocation();
  const title = pageTitleForPath(location.pathname);
  const initial = (email ?? "?").charAt(0).toUpperCase();
  const [company, setCompany] = useState<CompanyRow | null | undefined>(undefined);
  const [navOpen, setNavOpen] = useState(false);
  const [screenBackground, setScreenBackground] = useState<ScreenBackground>(() => getStoredScreenBackground());

  function onScreenBackgroundChange(value: ScreenBackground): void {
    setScreenBackground(value);
    applyScreenBackground(value);
  }

  const loadCompany = useCallback(async () => {
    try {
      const co = await api<CompanyRow | null>("/api/v1/company");
      setCompany(co);
    } catch {
      setCompany(null);
    }
  }, []);

  useEffect(() => {
    void loadCompany();
  }, [loadCompany]);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  const closeNav = () => setNavOpen(false);

  const systemNavVisible = NAV_SYSTEM.some((i) => !i.adminOnly || role === "admin");

  return (
    <div className="shell" data-testid="app-shell">
      <aside className={`shell-nav${navOpen ? " shell-nav--open" : ""}`} id="app-sidebar" aria-label="Primary navigation">
        <div className="shell-logo">
          <div className="shell-brand">Sarva</div>
          <span className="shell-tagline">Enterprise OS · IA + R1 orchestration</span>
        </div>
        <nav className="shell-nav-groups" aria-label="Primary">
          <NavItems items={NAV_MAIN} onNavigate={closeNav} />
          <div className="nav-section">Organization</div>
          <NavItems items={NAV_ORG} onNavigate={closeNav} />
          <div className="nav-section">Work</div>
          <NavItems items={NAV_WORK} onNavigate={closeNav} />
          {systemNavVisible ? (
            <>
              <div className="nav-section">System</div>
              <NavItems items={NAV_SYSTEM} onNavigate={closeNav} />
            </>
          ) : null}
        </nav>
        <div className="shell-footer">
          <span className="shell-user" data-testid="user-email">
            {email ?? "—"}
          </span>
          <span className="shell-role">{role === "admin" ? "Admin" : "Operator"}</span>
          <button type="button" className="linkish" onClick={logout} data-testid="logout">
            Sign out
          </button>
        </div>
      </aside>

      <div className="shell-body">
        <header className="shell-header">
          <button
            type="button"
            className="shell-menu-btn"
            aria-label={navOpen ? "Close menu" : "Open menu"}
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? "✕" : "☰"}
          </button>
          <h1 className="shell-page-title">{title}</h1>
          <div className="shell-company-wrap">
            <label className="shell-company-label" htmlFor="company-scope">
              Company
            </label>
            <select
              id="company-scope"
              className="shell-company-select"
              aria-label="Company scope"
              value={company?.id ?? ""}
              disabled={!company}
              onChange={() => undefined}
            >
              {company ? (
                <option value={company.id}>{company.name}</option>
              ) : (
                <option value="">{company === null ? "No company — create under Business units" : "Loading…"}</option>
              )}
            </select>
          </div>
          <div className="shell-theme-toggle-wrap">
            <ScreenBackgroundToggle value={screenBackground} onChange={onScreenBackgroundChange} />
          </div>
          <div className="shell-user-pill">
            <span className="shell-user-label">{email ?? "—"}</span>
            <div className="shell-avatar" aria-hidden>
              {initial}
            </div>
          </div>
        </header>
        {navOpen ? (
          <button
            type="button"
            className="shell-nav-backdrop"
            aria-label="Close navigation menu"
            onClick={closeNav}
          />
        ) : null}
        <main className="shell-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
