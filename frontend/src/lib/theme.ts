/**
 * @feat dark-mode: the shared theme logic — a validated read/write of the
 * `paperTheme` localStorage key and a stamp of `<html data-theme>`. Mirrors
 * the FOUC resolver in paper_base.html (same key, same light/dark/system
 * whitelist, same "garbage → system" fallback) so a reload lands on the same
 * theme the resolver picks before first paint. Dependency-free and shared by
 * both the DocHeader submenu and the PaperIndex cycle button.
 */

export type Theme = "light" | "dark" | "system";

// Cycle order used by the single-button toggle: system → light → dark → …
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

// The localStorage key the FOUC resolver (paper_base.html) reads/writes.
const STORAGE_KEY = "paperTheme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Read the persisted theme. Anything that isn't one of the three valid
 * values — an unset key, garbage, or a localStorage that throws — resolves
 * to "system", matching the resolver's fallback.
 */
export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Stamp the resolved theme on <html>, exactly as the resolver does. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * Persist the choice (best-effort — a throwing localStorage is swallowed)
 * and apply it immediately so the switch is instant with no reload.
 */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Best-effort persistence; the in-memory stamp below still takes effect.
  }
  applyTheme(theme);
}

/** Advance to the next theme in THEMES order and persist it. */
export function cycleTheme(current: Theme): Theme {
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  setTheme(next);
  return next;
}
