// Answers git's and ssh's questions (usernames, passwords, passphrases,
// unknown host keys) one at a time.
import { type Prompt, api, onPrompt } from "./api";
import { form } from "./dialogs";

let queue: Promise<void> = Promise.resolve();

async function answer(prompt: Prompt): Promise<void> {
  if (prompt.kind === "yesNo") {
    const result = await form({
      title: "Trust this host?",
      message: "SSH hasn't connected to this server before. Check the fingerprint before you continue.",
      detail: prompt.text,
      fields: [],
      confirmLabel: "Trust and connect",
    });
    await api.answerPrompt(prompt.id, result ? "yes" : "no");
    return;
  }
  const secret = prompt.kind === "secret";
  const result = await form({
    title: secret ? "Git needs a password" : "Git needs a username",
    message: prompt.text,
    fields: [{ name: "value", label: secret ? "Password or passphrase" : "Username", type: secret ? "password" : "text" }],
    confirmLabel: "Continue",
  });
  await api.answerPrompt(prompt.id, result ? String(result.value) : null);
}

export function listenForPrompts(): void {
  void onPrompt((prompt) => {
    queue = queue.then(() => answer(prompt)).catch(() => undefined);
  });
}
