/**
 * @feat dark-mode: the shared theme logic — a validated read/write of the
 * `paperTheme` localStorage key and a stamp of `<html data-theme>`. Mirrors
 * the FOUC resolver in paper_base.html (same key, same light/dark/system
 * whitelist, same "garbage → light" fallback, same theme-color meta rewrite)
 * so a reload lands on the same theme the resolver picks before first paint.
 * Paper defaults to light regardless of the OS setting (matching Datasette);
 * dark/system are explicit opt-ins. Dependency-free and shared by both the
 * DocHeader submenu and the PaperIndex cycle button.
 */

export type Theme = "light" | "dark" | "system";

// Cycle order used by the single-button toggle: light → dark → system → …
export const THEMES: readonly Theme[] = ["light", "dark", "system"];

// The localStorage key the FOUC resolver (paper_base.html) reads/writes.
const STORAGE_KEY = "paperTheme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Read the persisted theme. Anything that isn't one of the three valid
 * values — an unset key, garbage, or a localStorage that throws — resolves
 * to "light", matching the resolver's fallback (light is the default; dark
 * and system are explicit opt-ins).
 */
export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : "light";
  } catch {
    return "light";
  }
}

/**
 * Stamp the resolved theme on <html> and rewrite the theme-color meta to the
 * resolved bg, exactly as the FOUC resolver does. In "system" mode this reads
 * matchMedia once at call time — a static write, no live listener (a runtime
 * toggle only fires this on an explicit choice, so keeping it simple is fine).
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0d1117" : "#ffffff");
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
