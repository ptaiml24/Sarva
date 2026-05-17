import type { ScreenBackground } from "./screenBackground.js";

function IconSun({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
      />
    </svg>
  );
}

function IconMoon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden
    >
      <path
        fill="currentColor"
        stroke="none"
        d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 1 0 9.79 9.79z"
      />
    </svg>
  );
}

type Props = {
  value: ScreenBackground;
  onChange: (next: ScreenBackground) => void;
  /** Passed to outer `role="group"` wrapper */
  groupTestId?: string;
};

/** Day / Night screen palette — segmented sun & moon icons (persisted separately via `applyScreenBackground`). */
export function ScreenBackgroundToggle({ value, onChange, groupTestId }: Props) {
  return (
    <div
      className="screen-bg-toggle"
      role="group"
      aria-label="Screen background"
      data-testid={groupTestId ?? "screen-background-toggle"}
    >
      <button
        type="button"
        className={`screen-bg-toggle-btn${value === "day" ? " is-selected" : ""}`}
        aria-pressed={value === "day"}
        aria-label="Day"
        data-testid="screen-background-day"
        onClick={() => onChange("day")}
      >
        <IconSun className="screen-bg-toggle-svg" />
      </button>
      <button
        type="button"
        className={`screen-bg-toggle-btn${value === "night" ? " is-selected" : ""}`}
        aria-pressed={value === "night"}
        aria-label="Night"
        data-testid="screen-background-night"
        onClick={() => onChange("night")}
      >
        <IconMoon className="screen-bg-toggle-svg" />
      </button>
    </div>
  );
}
