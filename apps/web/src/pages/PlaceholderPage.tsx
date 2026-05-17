import type { ReactNode } from "react";

/** Thin shell for routes that are partially implemented or stubbed. Prefer dedicated pages with real copy over this default. */
export function PlaceholderPage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div data-testid="placeholder-page">
      <p className="muted page-intro" style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text)" }}>
        {title}
      </p>
      {children ?? (
        <p className="muted">
          This sidebar entry is reserved for a fuller experience. Related workflows may already exist under{" "}
          <strong>Projects</strong> or <strong>Admin</strong>; see product docs for the current release scope.
        </p>
      )}
    </div>
  );
}
