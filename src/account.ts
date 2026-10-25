// The right end of the title bar: the theme picker, and the person using
// the app (git's global name and email) with signing in and out.
import { type Profile, type Settings, api, errorMessage } from "./api";
import { THEMES } from "./appearance";
import { form } from "./dialogs";
import { el } from "./dom";
import { avatar } from "./format";
import { icon, iconButton } from "./icons";
import { type MenuItem, showMenu } from "./menu";
import { shortcutLabel } from "./platform";
import { notify } from "./toast";

export interface AccountHost {
  settings(): Settings;
  saveSettings(settings: Settings): Promise<void>;
  openPreferences(): void;
  showShortcuts(): void;
  /** The global identity changed; repositories show who they commit as again. */
  identityChanged(): void;
}

export class AccountControls {
  readonly root: HTMLElement;
  private readonly userButton: HTMLButtonElement;
  private profile: Profile | null = null;

  constructor(private readonly host: AccountHost) {
    const theme = iconButton("theme", "Theme", (event) => showMenu(this.themeItems(), event.currentTarget as HTMLElement), "icon-button titlebar-button");
    this.userButton = el("button", "user-chip");
    this.userButton.type = "button";
    this.userButton.addEventListener("click", () => this.userMenu());
    this.root = el("div", "titlebar-end", theme, this.userButton);
    this.render();
  }

  async load(): Promise<void> {
    try {
      this.profile = await api.profile();
    } catch {
      this.profile = null;
    }
    this.render();
  }

  /** Avatar colors come from the theme's palette. */
  themeChanged(): void {
    this.render();
  }

  private signedIn(): boolean {
    return Boolean(this.profile?.name || this.profile?.email);
  }

  private render(): void {
    const p = this.profile;
    if (p && this.signedIn()) {
      const name = p.name ?? p.email ?? "";
      const face = avatar(name, p.email ?? "", 22);
      face.removeAttribute("title");
      this.userButton.replaceChildren(face, el("span", "user-name", name), icon("chevronDown", 12));
      this.userButton.title = p.email ? `${name} <${p.email}>` : name;
      this.userButton.classList.remove("signed-out");
    } else {
      this.userButton.replaceChildren(icon("user", 16), el("span", "user-name", "Sign in"), icon("chevronDown", 12));
      this.userButton.title = "Set the name and email your commits are made with";
      this.userButton.classList.add("signed-out");
    }
  }

  private themeItems(): MenuItem[] {
    const settings = this.host.settings();
    return THEMES.map((theme) => ({
      label: theme.label,
      checked: settings.theme === theme.value,
      action: () => void this.host.saveSettings({ ...this.host.settings(), theme: theme.value }),
    }));
  }

  private userMenu(): void {
    const p = this.profile;
    const account: MenuItem[] = this.signedIn()
      ? [
          { heading: p?.name ?? p?.email ?? "", detail: p?.name ? (p.email ?? "No email set") : undefined },
          { label: "Edit name and email…", icon: "userEdit", action: () => void this.signIn() },
        ]
      : [
          { heading: "Not signed in", detail: "Commits need a name and email" },
          { label: "Sign in…", icon: "user", action: () => void this.signIn() },
        ];
    const items: MenuItem[] = [
      ...account,
      { separator: true },
      { heading: "Theme" },
      ...this.themeItems(),
      { separator: true },
      { label: "Preferences…", icon: "settings", hint: shortcutLabel("settings"), action: () => this.host.openPreferences() },
      { label: "Keyboard shortcuts", icon: "keyboard", hint: shortcutLabel("shortcuts"), action: () => this.host.showShortcuts() },
    ];
    if (this.signedIn()) items.push({ separator: true }, { label: "Sign out…", icon: "signOut", action: () => void this.signOut() });
    showMenu(items, this.userButton);
  }

  /** Sets git's global name and email. */
  private async signIn(): Promise<void> {
    const p = this.profile;
    const result = await form({
      title: this.signedIn() ? "Your name and email" : "Sign in",
      message: "Commits in every repository are made with this name and email, unless a repository sets its own (git's global user.name and user.email).",
      fields: [
        { name: "name", label: "Name", type: "text", value: p?.name ?? "" },
        { name: "email", label: "Email", type: "text", value: p?.email ?? "" },
      ],
      confirmLabel: this.signedIn() ? "Save" : "Sign in",
      validate: (v) => (!String(v.name).trim() ? "Enter a name." : !/^\S+@\S+$/.test(String(v.email).trim()) ? "Enter an email address." : null),
    });
    if (!result) return;
    try {
      this.profile = await api.setProfile(String(result.name), String(result.email));
    } catch (error) {
      notify.error("Couldn't save your name and email", errorMessage(error));
      return;
    }
    this.render();
    this.host.identityChanged();
  }

  /** Forgets the global identity and, if chosen, the passwords saved for the remotes' hosts. */
  private async signOut(): Promise<void> {
    const p = this.profile;
    const hosts = await api.remoteHosts().catch(() => [] as string[]);
    const who = p?.name && p.email ? `${p.name} <${p.email}>` : (p?.name ?? p?.email ?? "");
    const result = await form({
      title: "Sign out?",
      message: "Choose what GitCthulhu forgets. Committing then asks for a name and email again.",
      fields: [
        { name: "identity", label: `Forget my name and email (${who})`, type: "checkbox", value: true, hint: "Repositories that set their own keep it." },
        ...hosts.map((host, i) => ({
          name: `host${i}`,
          label: `Forget the saved password for ${host.replace(/^https?:\/\//, "")}`,
          type: "checkbox" as const,
          value: true,
          hint: i === hosts.length - 1 ? "Removed from git's credential helper (for example the keychain); git asks again on the next fetch or push." : undefined,
        })),
      ],
      confirmLabel: "Sign out",
      danger: true,
      validate: (v) => (Object.values(v).some(Boolean) ? null : "Choose something to forget."),
    });
    if (!result) return;
    const forget = hosts.filter((_, i) => result[`host${i}`]);
    try {
      await api.signOut(Boolean(result.identity), forget);
    } catch (error) {
      notify.error("Couldn't sign out", errorMessage(error));
      return;
    }
    await this.load();
    this.host.identityChanged();
    notify.success(result.identity ? "Signed out" : `Forgot the saved ${forget.length === 1 ? "password" : "passwords"}`);
  }
}
