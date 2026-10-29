/**
 * Theme runtime.
 *
 * The active theme is one attribute on <html>: `data-theme="midnight"`. Everything else is CSS.
 * The *source of truth* is the account (users.theme), so a theme follows you to any browser you
 * sign in from. localStorage is only a mirror, used for one thing: painting the right colours on
 * the sign-in screen (and on the first frame after a reload) before /api/auth/me has answered.
 */
import { DEFAULT_THEME, THEMES, isThemeId } from "../../src/shared/themes";

const STORAGE_KEY = "rslmc.theme";

export { THEMES, DEFAULT_THEME };

function readStored(): string {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    // Private mode / storage disabled: the default theme is still perfectly usable.
    return DEFAULT_THEME;
  }
}

function store(theme: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* storage unavailable — ignore */ }
}

export function currentTheme(): string {
  const value = document.documentElement.dataset.theme;
  return isThemeId(value) ? value : DEFAULT_THEME;
}

/**
 * Applies a theme. `persist` mirrors it into localStorage (used when the account changes it);
 * a server-driven sync passes persist = true as well, so the next cold load matches.
 */
export function applyTheme(theme: string | null | undefined, persist = true): string {
  const next = isThemeId(theme) ? theme : DEFAULT_THEME;
  const root = document.documentElement;
  if (root.dataset.theme !== next) root.dataset.theme = next;
  if (persist && readStored() !== next) store(next);
  // Lets the browser UI (form controls, scrollbars) match the theme temperature.
  root.style.colorScheme = "dark";
  return next;
}

/** Runs before React mounts so the first paint already has the right palette. */
export function applyStoredTheme(): string {
  return applyTheme(readStored(), false);
}

/** Keeps the mirror in step with the account, and drops it when nobody is signed in. */
export function syncThemeForUser(theme: string | null | undefined): void {
  if (theme) {
    applyTheme(theme, true);
    return;
  }
  // Signed out: keep the mirror (it is that person's own choice on this device) but make sure the
  // document has *some* valid theme rather than a stale attribute.
  applyTheme(readStored(), false);
}
