# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GitCthulhu is a desktop Git client in the spirit of GitKraken: a commit graph, branch and stash panels, staging down to single lines, a commit composer, merge/rebase/cherry-pick with conflict handling, remotes with credential prompts, tabs and a command palette. It is a Tauri 2 app. A Rust core drives the **git command line** (never libgit2), and a vanilla TypeScript UI runs in the webview. It's a clean-room rebuild: GitKraken 12.6.0 was studied with REA only as a feature reference (`docs/gitkraken-reference.md`); no GitKraken code, assets, themes or strings are used. The structure mirrors the owner's other Tauri app, Hostly (`../hostly`).

## Commands

Rust lives in `~/.cargo/bin`. If `cargo` isn't found, prefix commands with `export PATH="$HOME/.cargo/bin:$PATH"`.

```sh
npm install
npm run tauri dev                       # Vite on :1430 (Hostly uses :1420) + the Rust app
npx tsc --noEmit                        # type-check the UI
npm run build                           # tsc + vite build into dist/
cargo test --workspace                  # everything
cargo test -p gitcthulhu-core --lib     # core unit tests
cargo test -p gitcthulhu-core --test repo_ops stages_a_single_hunk_and_single_lines   # one integration test
cargo test -p gitcthulhu                # IPC tests through Tauri's mock runtime
cargo clippy --workspace --all-targets  # kept at zero warnings
cargo fmt --all
npx tauri build --debug --bundles app   # debug GitCthulhu.app in target/debug/bundle/macos
```

## Architecture

Keep logic in the lowest layer that can hold it.

### `crates/gitcthulhu-core` (no Tauri dependency)

- `git`: `Git` finds the executable (`GITCTHULHU_GIT`, `PATH`, then Homebrew/MacPorts/system paths, since Dock-launched apps get a minimal PATH) and runs it. Every process gets:
  - `-c core.quotepath=false -c color.ui=false`;
  - `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_EDITOR=true`, `GIT_PAGER=cat`;
  - English messages (`LANGUAGE`/`LC_MESSAGES=C`), because error text is matched, for example "not fully merged" or "would be overwritten";
  - stdin set to null.

  `run_progress` streams `--progress` lines (split on `\r` and `\n`). Windows gets `CREATE_NO_WINDOW`.
- `repo`: `Repo::open` (from any subdirectory; bare repositories are refused), `init`, `head`, `state` (merge, rebase with step/total, cherry-pick, revert, bisect, read from the git dir), `prepared_message` (MERGE_MSG).
- `refs`: `for-each-ref`, with tags peeled and remote names matched against `git remote` (they can contain `/`). Local branches carry upstream, ahead/behind and gone. Sorting is natural: v2 before v10.
- `log` + `graph`: `log::load` runs `git log --date-order --exclude=refs/stash --all HEAD <stash oids>`. It drops the stashes' internal index and untracked commits, cuts stash parents down to the first, and prepends a `work-in-progress` row (parent HEAD) when asked. `graph::layout` assigns lanes. Each row's `edges` run from the row above into it, and joins merge into an existing lane. Its unit tests pin the layout.
- `status`: `status --porcelain=v2 -z --untracked-files=all`, giving staged, unstaged and conflicted lists.
- `diff` + `inspect`: unified diff parsing; `partial_patch` builds hunk and line patches (rules below); `file_diff` for unstaged (untracked files use `--no-index`), staged, a commit (vs. its first parent; root commits via `diff-tree --root`) or a range; `commit_details`; `changed_files`.
- `ops`: every change. Merge, rebase, cherry-pick, revert and pull map failures in a non-clean state to `Error::Conflicts`. `sequence` continues, aborts or skips whatever is in progress; a merge "continues" by committing. Names and revisions starting with `-` are refused, and commit and tag messages go through stdin.
- `askpass`: a loopback TCP server with a random token. `configure` sets `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force` and the port and token variables. `run_if_helper` is the client mode of the app's own executable.
- `watch`: notify, quiet for 300 ms, then a `Change { refs, files }` classified from git-dir paths. Batches where every file is ignored are dropped via `check-ignore --stdin`.
- `store`: `AppData` (recent repos, tabs, settings) in `state.json`, versioned, written with write-then-rename, and tolerant of missing fields.

### `src-tauri`

- `commands.rs`: thin async commands. `read` runs queries in `spawn_blocking`; `write` also takes the repository's write lock, so changes never overlap. Errors become `CommandError { kind, message }`, with kinds from `Error::kind()` plus `notOpen`, `gitNotFound` and `internal`. Progress uses `Channel<String>`.
- `state.rs`: `AppState` holds the open repositories keyed by root path, each with its watcher and write lock. It also holds pending askpass prompts and an `Emit` closure; events go through it rather than an `AppHandle`, so commands are runtime-generic. `GITCTHULHU_DATA_DIR` overrides the data folder.
- `lib.rs`: the `handlers!` macro is the single command list, used by `run()` and by `tests.rs`. A new command goes there, in `src/api.ts`, and ideally in `tests.rs`.
- `menu.rs` (macOS only; other platforms have no menu bar and use the same shortcuts): the GitCthulhu, File, Edit, View and Window menus.
  - Our items emit `menu` with their id, which is a UI command name (`newTab`, `openRepo`, `cloneRepo`, `initRepo`, `reopenTab`, `closeTab`, `palette`, `search`, `toggleLeft`, `toggleRight`, `refresh`, `settings`).
  - `main.ts` `runCommand` handles both menu events and keyboard shortcuts. Menu accelerators take the key before the page does, so the two paths must agree.
  - ⌘W closes a tab, so the predefined Close Window item (also ⌘W) is left out.
- Events: `repo-changed { id, refs, files }` and `askpass-prompt { id, text, kind }`. Answers come back via `answer_prompt`.
- Window: `titleBarStyle: Overlay`, hidden title, min 950×640. The tab strip is the drag region (`core:window:allow-start-dragging`). Capabilities: `core:default`, window dragging, clipboard write, and dialog open.

### `src/` (UI)

- `api.ts`: typed wrappers in camelCase. They must match `tests.rs`, which calls with the same JSON.
- `workspace.ts`: tabs (repo or new-tab), restore and save, the palette's item list, and Preferences. It implements `Shell` for repository views.
  - Open, Clone and New repository (from the File menu, ⌘O, the palette or the toolbar's repo menu) run the shared flows in `welcome.ts`. They give the repository its own tab, just like + then picking it. A new-tab page in front is reused, an already-open repository just activates its tab, and cancelling changes nothing.
- `repo/repo-view.ts`: owns `snapshot` and `graph` and the selection. `refresh()` coalesces calls; it reloads the graph when asked, when HEAD moved, or when the WIP row appears or disappears. `run()` and `attempt()` give every operation the same feedback: progress toasts, conflicts explained, then a refresh.
- `repo/graph-view.ts`: the virtualized rows plus a canvas covering only the visible range. ROW 28 and LANE 20 roughly follow GitKraken's 28/22. Columns hide at container widths (sha < 980, date < 840, author < 680).
- `repo/detail-panel.ts`: the WIP staging lists, the composer (its draft survives refreshes; amend swaps in HEAD's message and back) and commit or stash details.
- `repo/diff-view.ts`: replaces the graph while open (Esc closes it). Click line numbers to select lines (⇧ for a range, one hunk at a time). Hunk buttons become "Stage N lines".
- `repo/actions.ts`: every operation with its dialogs, plus the ref and commit context menus. `repo/toolbar.ts` and `repo/ref-panel.ts` are the remaining pieces.
- `platform.ts`: the shortcut table, which handlers, tooltips and the palette all read. `main.ts` handles shortcuts in a capture-phase listener; dialogs and the palette take precedence.
- `dialogs.ts` (a promise-based `form()`, `confirmAction`, `promptText`, `refNameProblem`), `menu.ts`, `toast.ts`, `palette.ts` (fuzzy scoring), `askpass.ts` (a sequential prompt queue), `welcome.ts`.

## Contracts

- **Line staging.** The diff is re-read at apply time, and the shown hunk header must still match, otherwise the change is refused as stale.
  - Forward (stage): unselected removals become context and unselected additions are dropped.
  - Reverse (unstage with `--cached -R`, discard with `-R`): the opposite.
  - The patch is applied with `--recount`.
  - Untracked files are first marked `add -N`.
- **Never read git output in the user's locale.** Parsing relies on English text and `-z` formats.
- **Untrusted text.** Commit messages, names and paths go in through `textContent` (`dom.ts` `el()`). Nothing uses `innerHTML`.
- **Locks.** As in Hostly, take each `std::sync::Mutex` guard in its own `let`, and never call something that locks the same mutex while holding it.
- **Don't run one-time startup logic against the owner's live data.** The owner may keep `npm run tauri dev` running.

## Verifying the UI

There is no frontend test suite. Screen capture isn't permitted on this machine: `screencapture` and REA's native UI capture fail without Screen Recording, and REA's accessibility tree fails without Accessibility. The working method is:
1. dump real data for a demo repository through the core;
2. serve `dist/` with a mocked `window.__TAURI_INTERNALS__` that answers `invoke` from that dump;
3. screenshot it with headless Chrome (`--headless=new --screenshot --virtual-time-budget`).

The mock must ignore `blur` and `resize` listeners, because headless capture resizes the viewport, which closes menus.

## Design

The UI follows `DESIGN.md` (shared with Hostly):
- violet-dark surfaces;
- purple for actions and focus;
- green = added, orange = modified, red = removed or danger, cyan = renamed or links, pink = conflicts, live activity and scrollbars, yellow = search matches;
- the eight graph lane colors in `format.ts` `LANE_COLORS`, matching the core's `graph::COLORS`;
- Inter and JetBrains Mono via `@fontsource`, lucide icons via `src/icons.ts`.
- The logo: the owner's `logo.png` at the root is the source. Its corners are opaque black, so the derived copies are cut along the tile (at about x 46, y 45, 1162 px square, radius 285) with transparent corners:
  - `assets/app-icon.png`: 1024 px, the tile at 824 px with a shadow, for `npx tauri icon`;
  - `assets/logo.png`: 512 px, for the README;
  - `src/assets/logo.png`: 128 px, used by `src/brand.ts` `brandMark()` in the sidebar header and on the new-tab page.
