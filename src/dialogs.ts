// Promise-based modal dialogs, each built on its own <dialog> element.
import { el } from "./dom";

export type Field =
  | {
      name: string;
      label: string;
      type: "text" | "password";
      value?: string;
      placeholder?: string;
      hint?: string;
      mono?: boolean;
      /** Adds a "Browse…" button; resolves to the new value, or null to keep the old one. */
      browse?: () => Promise<string | null>;
    }
  | { name: string; label: string; type: "textarea"; value?: string; placeholder?: string; hint?: string; rows?: number }
  | { name: string; label: string; type: "checkbox"; value?: boolean; hint?: string }
  | { name: string; label: string; type: "select"; value?: string; options: { value: string; label: string }[]; hint?: string };

export type FormValues = Record<string, string | boolean>;

interface FormOptions {
  title: string;
  message?: string;
  detail?: string;
  fields: Field[];
  confirmLabel?: string;
  danger?: boolean;
  /** Returns an error to show, or null to accept. */
  validate?: (values: FormValues) => string | null;
  /** Extra buttons beside the confirm button; each closes with its value. */
  extra?: { label: string; value: string; danger?: boolean }[];
}

function read(fields: Field[], form: HTMLFormElement): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const input = form.elements.namedItem(field.name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    values[field.name] = field.type === "checkbox" ? (input as HTMLInputElement).checked : input.value;
  }
  return values;
}

/** Resolves to the field values, `{ button: value }` for an extra button, or null when cancelled. */
export function form(options: FormOptions): Promise<(FormValues & { button?: string }) | null> {
  const dialog = el("dialog", "dialog");
  const formNode = el("form");
  formNode.method = "dialog";
  formNode.append(el("h2", "", options.title));
  if (options.message) formNode.append(el("p", "message", options.message));
  if (options.detail) formNode.append(el("pre", "detail", options.detail));

  let first: HTMLElement | null = null;
  for (const field of options.fields) {
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (field.type === "textarea") {
      input = el("textarea");
      input.rows = field.rows ?? 4;
      input.value = field.value ?? "";
      input.placeholder = field.placeholder ?? "";
    } else if (field.type === "select") {
      input = el("select");
      for (const option of field.options) {
        const o = el("option", "", option.label);
        o.value = option.value;
        input.append(o);
      }
      input.value = field.value ?? field.options[0]?.value ?? "";
    } else {
      input = el("input");
      input.type = field.type;
      if (field.type === "checkbox") {
        input.checked = field.value ?? false;
      } else {
        input.value = field.value ?? "";
        input.placeholder = field.placeholder ?? "";
        input.autocomplete = "off";
        input.spellcheck = false;
        if (field.mono) input.classList.add("mono");
      }
    }
    input.name = field.name;
    first ??= input;
    let control: HTMLElement = input;
    if ((field.type === "text" || field.type === "password") && field.browse) {
      const browse = field.browse;
      const b = el("button", "button-secondary small", "Browse…");
      b.type = "button";
      b.addEventListener("click", async () => {
        const picked = await browse();
        if (picked !== null) {
          input.value = picked;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      control = el("span", "input-with-button", input, b);
    }
    const label =
      field.type === "checkbox" ? el("label", "checkbox", input, field.label) : el("label", "", field.label, control);
    formNode.append(label);
    if (field.hint) formNode.append(el("p", "hint", field.hint));
  }

  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  formNode.append(error);

  const confirm = el("button", `button-primary${options.danger ? " danger" : ""}`, options.confirmLabel ?? "OK");
  confirm.type = "submit";
  confirm.value = "ok";
  const cancel = el("button", "button-secondary", "Cancel");
  cancel.type = "button";
  const menu = el("menu", "", cancel);
  for (const extra of options.extra ?? []) {
    const b = el("button", `button-secondary${extra.danger ? " danger" : ""}`, extra.label);
    b.type = "submit";
    b.value = `extra:${extra.value}`;
    menu.append(b);
  }
  menu.append(confirm);
  formNode.append(menu);
  dialog.append(formNode);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let result: (FormValues & { button?: string }) | null = null;
    formNode.addEventListener("submit", (event) => {
      const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
      const values = read(options.fields, formNode);
      if (submitter?.value.startsWith("extra:")) {
        result = { ...values, button: submitter.value.slice(6) };
        return;
      }
      const problem = options.validate?.(values) ?? null;
      if (problem) {
        event.preventDefault();
        error.textContent = problem;
        return;
      }
      result = values;
    });
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
    if (first) {
      first.focus();
      if (first instanceof HTMLInputElement && first.type !== "checkbox") first.select();
    } else {
      confirm.focus();
    }
  });
}

export async function confirmAction(options: {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return (await form({ ...options, fields: [] })) !== null;
}

export async function promptText(options: {
  title: string;
  message?: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  const result = await form({
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    fields: [{ name: "value", label: options.label, type: "text", value: options.value, placeholder: options.placeholder }],
    validate: (values) => options.validate?.(String(values.value)) ?? null,
  });
  return result ? String(result.value) : null;
}

/** Branch and tag names, as `git check-ref-format` would accept them. */
export function refNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(n)) return "Names can't contain spaces or any of ~ ^ : ? * [ \\";
  if (n.startsWith("-") || n.startsWith("/") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock"))
    return "That name isn't allowed by Git.";
  if (n.includes("..") || n.includes("//") || n.includes("@{") || n === "@") return "That name isn't allowed by Git.";
  return null;
}

/** A read-only dialog showing `body`, with one button to close it. */
export function infoDialog(title: string, body: HTMLElement): Promise<void> {
  const dialog = el("dialog", "dialog wide");
  const close = el("button", "button-primary", "Done");
  close.type = "button";
  dialog.append(el("form", "", el("h2", "", title), body, el("menu", "", close)));
  document.body.append(dialog);
  return new Promise((resolve) => {
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve();
    });
    dialog.showModal();
    close.focus();
  });
}
