/** UI screen background palette (Day = light workspace, Night = dark per original mockups). */

export type ScreenBackground = "night" | "day";

export const SCREEN_BACKGROUND_STORAGE_KEY = "sarva_screen_background";

/** Read persisted choice (defaults to Night). */
export function getStoredScreenBackground(): ScreenBackground {
  if (typeof window === "undefined") return "night";
  try {
    const v = window.localStorage.getItem(SCREEN_BACKGROUND_STORAGE_KEY);
    return v === "day" ? "day" : "night";
  } catch {
    return "night";
  }
}

/** Apply palette to `<html>` and persist (omit persist when only hydrating from storage synchronously — same writes are idempotent). */
export function applyScreenBackground(mode: ScreenBackground): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.screenBg = mode === "day" ? "day" : "night";
  try {
    window.localStorage.setItem(SCREEN_BACKGROUND_STORAGE_KEY, mode);
  } catch {
    /* private mode / quota */
  }
}

/** Call before React paint so CSS variables apply on first meaningful paint. */
export function initScreenBackgroundFromStorage(): void {
  applyScreenBackground(getStoredScreenBackground());
}
