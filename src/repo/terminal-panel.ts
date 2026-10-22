// The embedded terminal, docked under the graph: the user's shell, started
// in the repository. One per repository tab; it keeps running while hidden.
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Channel } from "@tauri-apps/api/core";
import { api, errorMessage } from "../api";
import { currentTheme } from "../appearance";
import { el } from "../dom";
import { MONO_FONT, fontsReady } from "../fonts";
import { icon, iconButton } from "../icons";
import { shortcutLabel } from "../platform";
import type { ThemeName } from "../format";
import type { RepoView } from "./repo-view";

// The design's neons, as in Hostly's terminals. The light theme keeps them.
const DRACULA: ITheme = {
  background: "#1B1A23",
  foreground: "#F8F8F2",
  cursor: "#9580FF",
  cursorAccent: "#1B1A23",
  selectionBackground: "#454158",
  scrollbarSliderBackground: "rgba(255, 128, 191, 0.3)",
  scrollbarSliderHoverBackground: "rgba(255, 128, 191, 0.6)",
  scrollbarSliderActiveBackground: "rgba(255, 128, 191, 0.75)",
  black: "#1B1A23",
  red: "#FF9580",
  green: "#8AFF80",
  yellow: "#FFFF80",
  blue: "#9580FF",
  magenta: "#FF80BF",
  cyan: "#80FFEA",
  white: "#F8F8F2",
  brightBlack: "#7970A9",
  brightRed: "#FFAA99",
  brightGreen: "#A2FF99",
  brightYellow: "#FFFF99",
  brightBlue: "#AA99FF",
  brightMagenta: "#FF99CC",
  brightCyan: "#99FFEE",
  brightWhite: "#F8F8F2",
};

const THEMES: Record<ThemeName, ITheme> = {
  dracula: DRACULA,
  // Dark's achromatic palette, with green as the cursor.
  dark: {
    background: "#121212",
    foreground: "#FFFFFF",
    cursor: "#1ED760",
    cursorAccent: "#121212",
    selectionBackground: "#3E3E3E",
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.3)",
    scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.6)",
    scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.75)",
    black: "#282828",
    red: "#F3727F",
    green: "#1ED760",
    yellow: "#FFD85E",
    blue: "#539DF5",
    magenta: "#F573A0",
    cyan: "#A0C3D2",
    white: "#CBCBCB",
    brightBlack: "#7C7C7C",
    brightRed: "#F799A2",
    brightGreen: "#5CE38A",
    brightYellow: "#FFE28A",
    brightBlue: "#80B7F8",
    brightMagenta: "#F899BB",
    brightCyan: "#BDD6E0",
    brightWhite: "#FFFFFF",
  },
  light: DRACULA,
};

const ENTER = 13;
const MIN_HEIGHT = 120;

export class TerminalPanel {
  readonly root: HTMLElement;
  private readonly host: HTMLElement;
  private terminal: Terminal | null = null;
  private readonly fit = new FitAddon();
  private session: number | null = null;
  private exited = false;
  private height = 260;
  private readonly encoder = new TextEncoder();
  private observer: ResizeObserver | null = null;

  constructor(private readonly view: RepoView) {
    this.host = el("div", "terminal-host");
    const handle = el("div", "terminal-resizer");
    handle.addEventListener("pointerdown", (event) => this.resize(event, handle));
    const header = el(
      "div",
      "terminal-header",
      icon("terminal", 14),
      el("span", "terminal-title", "Terminal"),
      el("span", "terminal-where mono", view.info.root),
      iconButton("close", `Hide (${shortcutLabel("toggleTerminal")})`, () => this.toggle(false), "icon-button small"),
    );
    this.root = el("section", "terminal-panel", handle, header, this.host);
    this.root.hidden = true;
    this.root.style.height = `${this.height}px`;
  }

  applyTheme(): void {
    if (this.terminal) this.terminal.options.theme = THEMES[currentTheme()];
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(show = !this.isOpen()): void {
    this.root.hidden = !show;
    if (!show) {
      this.view.graphView.focus();
      return;
    }
    void this.start().then(() => {
      this.fitNow();
      this.terminal?.focus();
    });
  }

  dispose(): void {
    this.observer?.disconnect();
    if (this.session !== null) void api.terminalClose(this.session);
    this.session = null;
    this.terminal?.dispose();
  }

  /** Opens xterm once (after the mono font loads, as xterm measures it) and starts the shell. */
  private async start(): Promise<void> {
    if (!this.terminal) {
      await fontsReady;
      const terminal = new Terminal({ fontFamily: MONO_FONT, fontSize: 12, cursorBlink: true, scrollback: 5000, theme: THEMES[currentTheme()] });
      terminal.loadAddon(this.fit);
      terminal.open(this.host);
      terminal.onData((data) => this.input(this.encoder.encode(data)));
      terminal.onBinary((data) => this.input(Uint8Array.from(data, (c) => c.charCodeAt(0))));
      terminal.onResize(({ cols, rows }) => {
        if (this.session !== null) api.terminalResize(this.session, cols, rows).catch(() => undefined);
      });
      this.terminal = terminal;
      this.observer = new ResizeObserver(() => this.fitNow());
      this.observer.observe(this.host);
    }
    if (this.session === null) await this.spawn();
  }

  private async spawn(): Promise<void> {
    const terminal = this.terminal!;
    this.fitNow();
    const output = new Channel<ArrayBuffer>();
    output.onmessage = (bytes) => terminal.write(new Uint8Array(bytes));
    const exit = new Channel<number | null>();
    exit.onmessage = (code) => {
      this.session = null;
      this.exited = true;
      terminal.write(`\r\n\x1b[90m[${code === null ? "ended" : `exited with ${code}`}; press Enter to start a new shell]\x1b[0m\r\n`);
    };
    try {
      this.session = await api.terminalOpen(this.view.id, terminal.cols, terminal.rows, output, exit);
      this.exited = false;
    } catch (error) {
      terminal.write(`\x1b[31m${errorMessage(error)}\x1b[0m\r\n`);
      this.exited = true;
    }
  }

  private input(bytes: Uint8Array): void {
    if (this.session !== null) {
      api.terminalWrite(this.session, bytes).catch(() => undefined);
    } else if (this.exited && bytes.length === 1 && bytes[0] === ENTER) {
      this.exited = false;
      void this.spawn();
    }
  }

  private fitNow(): void {
    if (!this.terminal || this.root.hidden) return;
    try {
      this.fit.fit();
    } catch {
      // Not laid out yet.
    }
  }

  private resize(event: PointerEvent, handle: HTMLElement): void {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const start = this.height;
    document.body.classList.add("resizing-rows");
    const move = (e: PointerEvent) => {
      const max = (this.root.parentElement?.clientHeight ?? 800) - 120;
      this.height = Math.round(Math.min(Math.max(start + startY - e.clientY, MIN_HEIGHT), max));
      this.root.style.height = `${this.height}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing-rows");
      this.fitNow();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
  }
}
