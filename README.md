<p align="center">
  <img src="assets/logo.png" width="160" alt="GitCthulhu logo: a green Cthulhu whose tentacles are branches of a commit graph">
</p>

<h1 align="center">GitCthulhu</h1>

A graphical Git client in the spirit of GitKraken, with tentacles in every
branch. It is a Tauri 2 app: a Rust core drives the git command line, and a
vanilla TypeScript UI runs in the webview. It is a clean-room rebuild:
GitKraken served only as a feature reference (see
[docs/gitkraken-reference.md](docs/gitkraken-reference.md)), and none of its
code or assets are used.

## How to run (developers)

### 1. Install the prerequisites (once)

- **Git 2.30 or newer.** GitCthulhu runs your own `git`. It looks on `PATH`, then
  in Homebrew, MacPorts and the system locations. Set `GITCTHULHU_GIT` to use a
  specific one.
- **Node.js 22 or newer** (`.tool-versions` pins 24).
- **Rust 1.88 or newer**, installed with [rustup](https://rustup.rs). Then open a
  new terminal, or run `source "$HOME/.cargo/env"`.
- **System tools for your OS:**
  - **macOS:** Xcode Command Line Tools: `xcode-select --install`
  - **Windows 10/11:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
    with "Desktop development with C++". WebView2 is already installed, and
    [Git for Windows](https://git-scm.com/download/win) is needed.
  - **Linux (Debian/Ubuntu):**
    ```sh
    sudo apt install build-essential libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf git
    ```

### 2. Start the app

```sh
cd gitcthulhu        # the project folder
npm install          # first time, and after dependencies change
npm run tauri dev    # opens the GitCthulhu window
```

The first start compiles all the Rust dependencies, which takes a few minutes.
After that it starts quickly. While it's running, saving a frontend file reloads
the window, and saving a Rust file rebuilds and restarts the app. The dev server
uses port 1430, so it can run next to Hostly's (1420).

Open a repository with **File ▸ Open Repository…** (⌘O), the **+** tab, or a
recent one on the new-tab page.

### 3. Build an app or installer

```sh
npx tauri build --debug --bundles app   # quick debug build: target/debug/bundle/macos/GitCthulhu.app
npm run tauri build                     # release installers
```

Release installers are written to `target/release/bundle/`:

| OS | Output |
|---|---|
| macOS | `dmg/GitCthulhu_<version>_<arch>.dmg`, `macos/GitCthulhu.app` |
| Windows | `msi/*.msi`, `nsis/*-setup.exe` |
| Linux | `deb/*.deb`, `rpm/*.rpm`, `appimage/*.AppImage` |

These builds aren't signed yet; see Deploy in the follow-ups.

### 4. Check your changes

```sh
cargo test --workspace                  # core unit + integration tests against real repos, and IPC tests
cargo clippy --workspace --all-targets  # kept at zero warnings
cargo fmt --all
npx tsc --noEmit                        # type-check the UI
```

To see what opening and refreshing a big repository costs, time the core's
queries against it. This only reads; nothing in the repository changes:

```sh
cargo run --release -p gitcthulhu-core --example bench -- ~/path/to/big-repo [commits]
```

### Change the logo

The logo source is `logo.png` at the root. `assets/app-icon.png` (the padded
macOS icon), `assets/logo.png` (this README) and `src/assets/logo.png` (the
sidebar and new-tab page) are cut from it with transparent corners. After
replacing them, regenerate the app icons:

```sh
npx tauri icon assets/app-icon.png -o src-tauri/icons
rm -rf src-tauri/icons/android src-tauri/icons/ios   # desktop only
```

### Troubleshooting

- **`cargo: command not found`:** run `source "$HOME/.cargo/env"` or open a new
  terminal.
- **`Port 1430 is already in use`:** another `npm run tauri dev` for GitCthulhu
  is still running. Stop it first.
- **"Git isn't installed":** install Git, or set `GITCTHULHU_GIT` to its path. Apps
  opened from the Dock get a minimal `PATH`.
- **A push or pull asks for nothing and fails:** GitCthulhu shows git's and
  ssh's prompts as dialogs. If none appeared, check that a credential helper or
  ssh-agent is set up, because those are used first.

## Deploy to production

Not written yet. It comes next session, following Hostly's: a signed release
installed to `/Applications`, CI on macOS, Windows and Linux, and the Linux
Docker check. See [Next session: deploy](#next-session-deploy-like-hostly).

## What it does

- **Commit graph** of every branch, tag and remote. Lanes are drawn on a canvas,
  with colored branch and tag labels, author initials in the dots, and a work-in-progress
  row and stashes drawn into the graph. It's virtualized, so 2,000+ commits scroll smoothly.
  Find commits by message, author or SHA (⌘F). When a commit has more labels
  than fit, its "+N" chip lists them all; click one to select it.
- **Graph controls**:
  - hide or solo branches (the eye on each row, or right-click), and hide tags,
    stashes or a remote's branches, with a banner to show everything again;
  - resizable and hideable columns, including a Changes column (+/− per
    commit). The graph column fits its lanes, or drag it wider for
    repositories with many lanes;
  - Load more past the commit limit;
  - search across all history, which finds commits beyond those loaded.
- **Left panel**: local branches (in folders by `/`, with ahead/behind counts),
  remotes, tags and stashes, with a filter (⌥⌘F). Double-click to check out;
  right-click for everything else.
- **Submodules, worktrees, Git LFS and Gitflow** in the left panel:
  - **Submodules**: open one in a tab, check it out or update it, or add one.
  - **Worktrees**: add one (on a new or existing branch), open it in a tab,
    remove it or prune missing ones.
  - **LFS**: track or untrack patterns, see how many files aren't downloaded,
    and pull, prune or install the hooks.
  - **Gitflow**: set it up, then start and finish features, releases and
    hotfixes (finishing merges, tags and cleans up; undoable). It's built in,
    so `git flow` doesn't need to be installed.
- **Staging**: unstaged, staged and conflicted files, as a list or a folder
  tree.
  - ⌘-click and ⇧-click select several files to stage, unstage, discard or
    stash together; `s` and `u` stage and unstage the selection.
  - Stage, unstage or discard whole files, hunks or single lines, including
    lines picked from several hunks at once.
- **Commit composer** with a summary counter, description, amend, ⌘↩ to commit
  and ⇧⌘↩ to stage everything and commit.
  - Sign-off and skip-hooks (`--no-verify`) options, and the message starts
    from your `commit.template`.
  - It shows who commits are made as; click to change it for this repository
    or globally. If git doesn't know who you are, it asks rather than failing.
- **Diffs** for working-tree changes and for any commit (against its first
  parent):
  - syntax highlighting for about 40 languages, with the changed words marked
    inside changed lines;
  - unified or split (side by side), the full file, or ignoring whitespace;
  - images shown before and after.

  Hunk and line staging work in both layouts and with the full file.
- **Branches and history**: create, rename, delete (with a force option when
  unmerged), check out (remote branches get a tracking branch; auto-stash when
  local changes are in the way), fast-forward, merge, rebase, cherry-pick,
  revert, reset (soft, mixed or hard), tags (lightweight and annotated, pushed or
  deleted on remotes).
- **Interactive rebase**: plan a rebase onto any commit or branch in a panel.
  Drag commits to reorder them (or ⌥↑ ⌥↓), and pick, reword, squash, fix up or
  drop each one (P R S F D). Right-click a commit to edit its message, move it
  up or down, or drop it. It auto-stashes, and conflicts stop in the usual
  banner.
- **Undo / Redo** (⌘Z / ⇧⌘Z, or the toolbar):
  - commit and amend (the changes come back staged);
  - checkout, branch and tag create, rename and delete, and fast-forward;
  - merge, rebase, interactive rebase, cherry-pick, revert, reset and pull (with
    `reset --keep`, so your local edits are safe);
  - discards of files, hunks or lines (their contents are restored);
  - stash and stash delete.

  An operation that stopped on conflicts is undone as a whole. If the
  repository changed outside the app in between, undo refuses rather than
  rewinding someone else's work.
- **Drag and drop**: drag a branch label in the graph, or a branch in the left
  panel, onto another branch or commit to merge, rebase, interactive rebase or
  fast-forward. It checks out the right branch first if needed.
- **Multi-select**: ⌘-click (Ctrl-click) to add commits and ⇧-click for a
  range. Then cherry-pick or revert them together, or with two selected see
  every file that changed between them, each opening its diff.
- **File history and blame**: right-click a file, use History or Blame in a
  diff, or press ⇧⌘H to find a file. The panel lists every commit that changed
  it, following renames. Each shows its change to the file, or blame as of that
  commit with consecutive lines grouped by author; click a group to go to its
  commit.
- **Merge tool**: click a conflicted file. Each conflict shows our and their
  lines side by side. Tick the lines to keep, or choose Ours, Theirs, Both or
  Neither, and see the result underneath. You can also edit the whole output by
  hand. Save and mark resolved (⌘S) writes and stages the file, and moves on to
  the next conflict. Binary files and delete/modify conflicts get a
  keep-or-delete choice.
- **Conflicts**: a banner with Continue, Skip or Abort for merges, rebases,
  cherry-picks and reverts. Take ours or theirs, or mark resolved; conflicted
  files show their markers.
- **Remotes**: fetch, pull (fast-forward if possible, fast-forward only, or
  rebase), push (asks for a remote the first time; offers pull or force push
  with lease when rejected), add and remove remotes, optional auto-fetch.
  - Edit a remote's name and URL.
  - Push a branch under another name ("Push X to…").
  - Set, change or stop tracking a branch's upstream.
- **Stashes**: stash everything or only the selected files, then apply, pop,
  rename or delete. A stash's details include the untracked files it holds.
- **Patches**: save one or more commits as a `format-patch` file, or your
  uncommitted changes as a plain patch. Apply a patch to the working tree, or
  as commits (`git am`, which continues or aborts in the conflict banner).
- **Open elsewhere**: open a file or the whole repository in the editor set in
  Preferences (for example `code` or `subl -n`), or in the system's default
  app when none is set. Open a file's change in `git difftool` (your
  `diff.tool`).
- **Credentials**: git and ssh prompts (HTTPS username and password, key
  passphrases, unknown host keys) appear as dialogs. GitCthulhu's own executable
  is the askpass helper. Your credential helpers and ssh-agent keep working.
- **Terminal** (⌘\`): your shell, docked under the graph and started in the
  repository, with the design's colors. It keeps running while hidden, and
  Enter starts a new one after it exits. The system terminal is still in the
  repo menu.
- **Tabs** with restore on launch and drag to reorder, recent and favorite
  repositories, and a command palette (⌘P) for commands, branch checkout and
  recent repos.
- **Clone, init and find**: clone with options (shallow, a single branch,
  submodules), and pick the destination folder inside the dialog. Start a new
  repository, or scan a folder for repositories (four levels deep, skipping
  `node_modules` and the like) to add them to the recent list.
- **View**: zoom (⌘= / ⌘− / ⌘0), a Dracula (the default), dark, light or system theme (Preferences),
  and a keyboard shortcut cheat sheet (⌘/).
- **A File menu** on macOS: New Tab (⌘T), Open Repository… (⌘O), Clone
  Repository…, New Repository…, Reopen Closed Tab (⇧⌘T), Close Tab (⌘W).
  Opening from any tab puts the repository in a tab of its own.
- **Long histories**: when the graph is slow to load because git has no
  commit-graph file, a banner offers to index the history (`git commit-graph
  write`, as `git gc` does). It runs in the background with progress. Search
  walks the history once and stops as soon as it has enough matches.
- Live refresh when files or refs change outside the app. It waits for writes
  to settle, but while a build keeps writing it still refreshes, at most once a
  second.

## Follow-ups

Measured against GitKraken 12.6.0's feature set
([docs/gitkraken-reference.md](docs/gitkraken-reference.md)). Tick items off
as they land.

### Missing GitKraken features, most important first

- [x] **Interactive rebase.** Reorder commits by dragging, and pick, reword,
  squash or drop them (GitKraken's `d`/`p`/`r` keys). Also "Edit commit
  message" on older commits. Run it through a `GIT_SEQUENCE_EDITOR` helper,
  the way the askpass helper works.
- [x] **Undo / Redo** (⌘Z / ⇧⌘Z) for checkout, commit, amend, reset, merge,
  and branch create and delete, using the reflog.
- [x] **Three-way merge conflict tool.** A/B/output panes; take lines or chunks
  from either side; edit the output; save and resolve (⌘S).
- [x] **Drag and drop in the graph.** Drag a branch label onto another branch
  to merge or rebase it.
- [x] **Multi-select in the graph.** Cherry-pick or revert several commits at
  once, and compare two commits. The backend already has `compare_files` and a
  `range` diff target.
- [x] **File history and blame** (⇧⌘H).
- [x] **Diff upgrades:** syntax highlighting, word-level changes, a
  side-by-side view, image diffs, an ignore-whitespace toggle, and a
  full-file view.
- [x] **Left panel sections:** submodules, worktrees, Git LFS and Gitflow.
- [x] **Embedded terminal** (xterm.js and a PTY, reusing Hostly's terminal
  pane). Today the button opens the system terminal.
- [x] **Graph controls:**
  - hide or solo branches, and hide tags or stashes;
  - resizable and hideable columns, plus a "changes" column;
  - a "load more commits" button;
  - commit search across all of history, not just the loaded commits.

### Smaller gaps

- [x] Staging panel: a folder tree as well as the path list, selecting several
  files at once, `s`/`u` to stage and unstage the selected file, and line
  selection across more than one hunk.
- [x] Commit options: sign-off, skip hooks (`--no-verify`), commit templates
  (`commit.template`).
- [x] Ask for the author's name and email when git doesn't know them, instead
  of showing git's "Author identity unknown" error. Show the per-repository
  identity somewhere.
- [x] Remotes: edit a remote's URL, push to a different branch name ("Push X
  to…"), set or change a branch's upstream explicitly.
- [x] Clone options: shallow clone, a single branch, recursive submodules.
- [x] Conflicts where one side deleted the file: "take ours/theirs" needs to
  handle `git rm` as well as checkout.
- [x] Stash: stash only the selected files, rename a stash, and see a stash's
  untracked files.
- [x] Patches: create a patch from commits, and apply a patch file.
- [x] Tabs: drag to reorder (like Hostly).
- [x] View: zoom in and out (⌘+ / ⌘−), a light theme, and a keyboard shortcut
  cheat sheet (⌘/).
- [x] Open a file or the repository in the user's editor, and open a file in an
  external diff tool (⌘D in GitKraken; here it's a button, since ⌘D stays
  unbound).
- [x] Clone dialog: pick the destination folder without the dialog closing and
  reopening.
- [x] Show all of a commit's branch and tag labels, not just the first plus a
  "+N" tooltip.
- [x] The graph is capped at 320 px wide; repositories with many lanes need it
  to scroll or resize.
- [x] Find repositories on disk to open (scan a folder for repositories).

### Next session: deploy (like Hostly)

- [ ] **Deploy to production**, following Hostly's "Deploy to production":
  - raise the version in `src-tauri/tauri.conf.json`, `package.json` and
    `src-tauri/Cargo.toml`;
  - run the checks;
  - find the signing identity with `security find-identity -v -p codesigning`;
  - build a signed release (`APPLE_SIGNING_IDENTITY`, notarization for
    distribution);
  - install it to `/Applications`;
  - document the Windows and Linux equivalents.
- [ ] **CI**: `.github/workflows/ci.yml` that runs fmt, clippy, the tests, the
  type-check and `tauri build` on Ubuntu, Windows and macOS, and uploads the
  installers.
- [ ] **`npm run check:linux`**: the full check, a `.deb` and a launch screenshot
  on Debian in Docker, like Hostly's `scripts/linux-check.sh`.
- [ ] A "Deploy to production" section in this README once that works.

### Not features, but still to do

- [ ] Exercise the real app window end to end: dialogs, file pickers, panel
  resizing, the File menu, and password and host-key prompts. So far the UI
  has been checked in headless Chrome with real repository data, and the
  backend through tests.
- [ ] Test on Windows and Linux. CI is covered under the next session's deploy.
- [x] Performance on large repositories. Measured on homebrew-cask (442k
  commits) with `examples/bench.rs`:
  - the graph's 2,000 commits loaded in 1.8 s without a commit-graph and
    0.18 s with one, and file history in 0.55 s and 0.05 s. A slow load
    offers to index;
  - search went from 2.3 s to 0.14 s: one walk instead of two, which stops
    once it has enough;
  - the watcher refreshes at most once a second while a build keeps writing.
- [ ] Smaller graph payloads: each row lists every lane passing through it,
  so with many lanes the graph is about 1 KB of JSON per commit (2 MB for
  2,000 commits on 55 lanes). Sending only lane starts and ends would shrink
  it.
- [ ] A search that matches nothing still reads every commit (about 3 s on
  homebrew-cask); a commit-graph doesn't help with message text.
