import { type CSSProperties, type ReactNode, useState } from "react";

const summaryStyle: CSSProperties = {
  cursor: "pointer",
  margin: 0,
  listStylePosition: "outside",
};

/**
 * Expandable `<details>` panel styled as `.card`.
 * Prefer this over ad-hoc `<details className="card">` copies so headings and subtitles stay consistent.
 */
export function CollapsibleCard({
  heading,
  subtitle,
  defaultExpanded = false,
  children,
  "data-testid": testId,
  style,
  className = "card",
}: {
  heading: ReactNode;
  subtitle?: ReactNode;
  /** When true, section starts expanded (still collapsible). */
  defaultExpanded?: boolean;
  children: ReactNode;
  "data-testid"?: string;
  style?: CSSProperties;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultExpanded);

  return (
    <details
      className={className}
      data-testid={testId}
      style={style}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="card-title" style={summaryStyle}>
        {heading}
        {subtitle ?
          <>
            {" "}
            <span className="muted" style={{ fontWeight: "normal", fontSize: "0.85rem" }}>
              · {subtitle}
            </span>
          </>
        : null}
      </summary>
      {children}
    </details>
  );
}
