// Theme and zoom, from Settings.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./api";
import { type ThemeName, setLanePalette } from "./format";

/** Every theme choice, in menu order. A new theme goes here, in styles.css and in format.ts's LANE_COLORS. */
export const THEMES: { value: Settings["theme"]; label: string }[] = [
  { value: "dracula", label: "Dracula" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Match the system" },
];

export function isTheme(value: unknown): value is Settings["theme"] {
  return THEMES.some((t) => t.value === value);
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const THEME_KEY = "gitcthulhu.theme";
let following: Settings["theme"] = "dracula";
let current: ThemeName = "dracula";
let onSystemChange: (() => void) | null = null;

/** The theme in use, with `system` resolved. */
export function currentTheme(): ThemeName {
  return current;
}

/** Sets the theme; `system` follows the OS appearance (Dracula or light) as it changes. */
export function applyTheme(theme: Settings["theme"], changed: () => void): void {
  following = theme;
  current = theme === "system" ? (darkQuery.matches ? "dracula" : "light") : theme;
  document.documentElement.dataset.theme = current;
  setLanePalette(current);
  onSystemChange = changed;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Settings still hold the theme; this copy only avoids a flash at launch.
  }
}

/**
 * Applies the theme last used, before the app data loads, so the window
 * doesn't open in the default theme and then switch. Settings stay the source
 * of truth and are applied right after.
 */
export function applySavedTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    return;
  }
  if (isTheme(saved)) applyTheme(saved, () => undefined);
}

darkQuery.addEventListener("change", () => {
  if (following === "system" && onSystemChange) {
    applyTheme("system", onSystemChange);
    onSystemChange();
  }
});

export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function applyZoom(zoom: number): void {
  getCurrentWebview()
    .setZoom(zoom)
    .catch(() => undefined);
}

/** The next zoom step up (`1`) or down (`-1`) from `zoom`. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? ZOOM_STEPS[0];
}
