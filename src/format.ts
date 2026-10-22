// Formatting shared by the graph and the panels.
import type { ChangeKind } from "./api";

export function shortSha(oid: string): string {
  return oid.slice(0, 7);
}

const UNITS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.35, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function relativeTime(seconds: number, now = Date.now() / 1000): string {
  let delta = seconds - now;
  for (const [size, unit] of UNITS) {
    if (Math.abs(delta) < size) {
      return relative.format(Math.round(delta), unit);
    }
    delta /= size;
  }
  return absolute.format(seconds * 1000);
}

export function absoluteTime(seconds: number): string {
  return absolute.format(seconds * 1000);
}

export function formatTime(seconds: number, style: "relative" | "absolute"): string {
  return style === "relative" ? relativeTime(seconds) : absoluteTime(seconds);
}

/** Up to two initials from a name, for avatars. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

export type ThemeName = "dracula" | "dark" | "light";

/** Graph lane colors per theme, in the order lanes take them. */
export const LANE_COLORS: Record<ThemeName, string[]> = {
  /** The design's neons. */
  dracula: ["#9580FF", "#80FFEA", "#FF80BF", "#8AFF80", "#FFCA80", "#FFFF80", "#FF9580", "#B9AEFF"],
  /** Dark's UI is achromatic, so the graph is where its color lives. */
  dark: ["#1ED760", "#509BF5", "#F573A0", "#FFA42B", "#B49BC8", "#CDF564", "#F3727F", "#A0C3D2"],
  /** Dracula's hues, dark enough to read on the light theme. */
  light: ["#6a4fe0", "#0b847b", "#c2368a", "#1d8f35", "#a86400", "#857500", "#cf432c", "#7d6bd6"],
};

let palette = LANE_COLORS.dracula;

export function setLanePalette(theme: ThemeName): void {
  palette = LANE_COLORS[theme];
}

export function laneColor(index: number): string {
  return palette[index % palette.length];
}

/** A stable avatar color for an email address. */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (const c of seed.toLowerCase()) {
    hash = (hash * 31 + c.charCodeAt(0)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

export function avatar(name: string, email: string, size = 20): HTMLElement {
  const node = document.createElement("span");
  node.className = "avatar";
  node.textContent = initials(name);
  node.style.setProperty("--avatar", avatarColor(email || name));
  node.style.width = node.style.height = `${size}px`;
  node.style.fontSize = `${Math.round(size * 0.42)}px`;
  node.title = email ? `${name} <${email}>` : name;
  return node;
}

export const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  typeChanged: "Type changed",
  untracked: "New",
  conflicted: "Conflicted",
};

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { dir: "", name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
