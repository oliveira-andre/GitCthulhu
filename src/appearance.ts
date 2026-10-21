// Theme and zoom, from Settings.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./api";
import { setLightPalette } from "./format";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let following: Settings["theme"] = "dark";
let onSystemChange: (() => void) | null = null;

/** Sets the theme; `system` follows the OS appearance as it changes. */
export function applyTheme(theme: Settings["theme"], changed: () => void): void {
  following = theme;
  const light = theme === "light" || (theme === "system" && !darkQuery.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  setLightPalette(light);
  onSystemChange = changed;
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
