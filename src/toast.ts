// Notices in the bottom-right corner. Long operations show one that
// follows git's progress and turns into the result.
import { el } from "./dom";
import { icon } from "./icons";

const host = () => document.querySelector<HTMLElement>("#toasts")!;

export type ToastTone = "info" | "success" | "error" | "progress";

export interface Toast {
  update(text: string): void;
  done(tone: Exclude<ToastTone, "progress">, title: string, detail?: string): void;
  close(): void;
}

export function toast(tone: ToastTone, title: string, detail?: string): Toast {
  const titleNode = el("div", "toast-title", title);
  const detailNode = el("div", "toast-detail", detail ?? "");
  detailNode.hidden = !detail;
  const node = el("div", `toast ${tone}`, el("span", "toast-mark"), el("div", "toast-body", titleNode, detailNode));
  const close = el("button", "toast-close");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.append(icon("close", 14));
  node.append(close);
  host().append(node);

  let timer: number | undefined;
  const remove = () => {
    window.clearTimeout(timer);
    node.classList.add("leaving");
    window.setTimeout(() => node.remove(), 160);
  };
  const schedule = (t: ToastTone) => {
    window.clearTimeout(timer);
    // Errors stay until dismissed; they usually need reading.
    if (t !== "error" && t !== "progress") {
      timer = window.setTimeout(remove, t === "success" ? 3500 : 5000);
    }
  };
  close.addEventListener("click", remove);
  schedule(tone);

  return {
    update(text) {
      detailNode.textContent = text;
      detailNode.hidden = !text;
    },
    done(t, newTitle, newDetail) {
      node.className = `toast ${t}`;
      titleNode.textContent = newTitle;
      detailNode.textContent = newDetail ?? "";
      detailNode.hidden = !newDetail;
      schedule(t);
    },
    close: remove,
  };
}

export const notify = {
  info: (title: string, detail?: string) => toast("info", title, detail),
  success: (title: string, detail?: string) => toast("success", title, detail),
  error: (title: string, detail?: string) => toast("error", title, detail),
};
