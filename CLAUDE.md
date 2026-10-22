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
cargo run --release -p gitcthulhu-core --example bench -- <repo> [limit]   # time the snapshot, graph and search queries (read-only)
```

Large real repositories on this machine for `bench`: `~/homebrew-cask` (442k commits, no commit-graph) and `/opt/homebrew` (53k). They belong to the owner, so only read them. To try something that writes, use `git clone --local --no-checkout` into the scratchpad, which hard-links the objects.

## Architecture

Keep logic in the lowest layer that can hold it.

### `crates/gitcthulhu-core` (no Tauri dependency)

- `git`: `Git` finds the executable (`GITCTHULHU_GIT`, `PATH`, then Homebrew/MacPorts/system paths, since Dock-launched apps get a minimal PATH) and runs it. Every process gets:
  - `-c core.quotepath=false -c color.ui=false`;
  - `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_EDITOR=true`, `GIT_PAGER=cat`;
  - English messages (`LANGUAGE`/`LC_MESSAGES=C`), because error text is matched, for example "not fully merged" or "would be overwritten";
  - stdin set to null.

  `run_progress` streams `--progress` lines (split on `\r` and `\n`). `stream` hands over NUL-terminated stdout records as they arrive and kills git when the callback returns `false` (search stops early that way). Windows gets `CREATE_NO_WINDOW`.
- `repo`: `Repo::open` (from any subdirectory; bare repositories are refused), `init`, `head`, `state` (merge, rebase with step/total, cherry-pick, revert, `git am`, bisect, read from the git dir), `prepared_message` (MERGE_MSG), `has_commit_graph`.
- `refs`: `for-each-ref`, with tags peeled and remote names matched against `git remote` (they can contain `/`). Local branches carry upstream, ahead/behind and gone. Sorting is natural: v2 before v10.
- `log` + `graph`: `log::load` runs `git log --date-order --exclude=refs/stash --all HEAD <stash oids>`. It drops the stashes' internal index and untracked commits, cuts stash parents down to the first, and prepends a `work-in-progress` row (parent HEAD) when asked. `RefFilter` hides or solos refs (`--exclude` must come before `--all`). `Graph.indexed` says whether a commit-graph exists: without one, `--date-order` reads the whole history first (1.8 s on homebrew-cask, 0.18 s with one), and the UI offers `ops::write_commit_graph` after a slow load. `graph::layout` assigns lanes. Each row's `edges` run from the row above into it, and joins merge into an existing lane. Its unit tests pin the layout.
  - `search` is one `log -z --all` walk matched in Rust (message, author name or email), because git ANDs `--author` with `--grep`. `commit_stats` feeds the Changes column.
- `status`: `status --porcelain=v2 -z --untracked-files=all`, giving staged, unstaged and conflicted lists.
- `diff` + `inspect`: unified diff parsing; `partial_patch` builds hunk and line patches (rules below); `file_diff` for unstaged (untracked files use `--no-index`), staged, a commit (vs. its first parent; root commits via `diff-tree --root`) or a range; `commit_details`; `changed_files`.
- `ops`: every change. Merge, rebase, cherry-pick, revert, `am` and pull map failures in a non-clean state to `Error::Conflicts`. `sequence` continues, aborts or skips whatever is in progress; a merge "continues" by committing. Names and revisions starting with `-` are refused, and commit and tag messages go through stdin. Line staging is `apply_selection` (several hunks at once, with the diff's context size). Also commit options and identity, stash by paths/rename/untracked, patches (`format_patch`, `apply_patch` with `--3way`), remote edits and upstreams.
- `rebase`: interactive rebase. `GIT_SEQUENCE_EDITOR="cp '<todo>'"` copies in the plan the UI built; rewords are `exec git commit --amend -F <file>`, so no editor runs. Scratch files live in `<gitdir>/gitcthulhu-rebase`.
- `undo`: `History` per repository. Each entry records HEAD and the branch and tag tips before and after (`RefState`); commits undo with a soft reset, other history changes with `reset --keep`. Discards back up file contents first; stashes record `StashDrop`/`StashPush`. An operation stopped on conflicts is `suspend`ed and recorded when `sequence` finishes it. Undo refuses when refs moved outside the app.
- `conflict`: the merge tool's data, from stages 1–3 merged with `git merge-file -p --diff3`; `resolve` and `resolve_deleted` write and stage.
- `history`: `file_history` (follows renames), `blame` (porcelain), `tracked_files`.
- `submodules`, `worktrees`, `lfs`, `gitflow` (built in, using git-flow's `gitflow.*` config keys).
- `terminal`: the user's login shell in a PTY (portable-pty), adapted from Hostly.
- `discover`: finds repositories under a folder (skips `node_modules` and the like).
- `askpass`: a loopback TCP server with a random token. `configure` sets `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force` and the port and token variables. `run_if_helper` is the client mode of the app's own executable.
- `watch`: notify, quiet for 300 ms, then a `Change { refs, files }` classified from git-dir paths. While writes keep coming it still reports after at most 2 s (`MAX_WAIT`), and never more than once a second (`MIN_GAP`). Batches where every file is ignored are dropped via `check-ignore --stdin`.
- `store`: `AppData` (recent repos, tabs, settings) in `state.json`, versioned, written with write-then-rename, and tolerant of missing fields.

### `src-tauri`

- `commands.rs`: thin async commands. `read` runs queries in `spawn_blocking`; `write` also takes the repository's write lock, so changes never overlap. Errors become `CommandError { kind, message }`, with kinds from `Error::kind()` plus `notOpen`, `gitNotFound` and `internal`. Progress uses `Channel<String>`.
- `state.rs`: `AppState` holds the open repositories keyed by root path, each with its watcher and write lock. It also holds pending askpass prompts and an `Emit` closure; events go through it rather than an `AppHandle`, so commands are runtime-generic. `GITCTHULHU_DATA_DIR` overrides the data folder.
- `lib.rs`: the `handlers!` macro is the single command list, used by `run()` and by `tests.rs`. A new command goes there, in `src/api.ts`, and ideally in `tests.rs`.
- `menu.rs` (macOS only; other platforms have no menu bar and use the same shortcuts): the GitCthulhu, File, Edit, View and Window menus.
  - Our items emit `menu` with their id, which is a UI command name (`newTab`, `openRepo`, `cloneRepo`, `initRepo`, `reopenTab`, `closeTab`, `palette`, `search`, `toggleLeft`, `toggleRight`, `refresh`, `settings`, `zoomIn`, `zoomOut`, `zoomReset`, `shortcuts`).
  - `main.ts` `runCommand` handles both menu events and keyboard shortcuts. Menu accelerators take the key before the page does, so the two paths must agree.
  - ⌘W closes a tab, so the predefined Close Window item (also ⌘W) is left out.
- Events: `repo-changed { id, refs, files }` and `askpass-prompt { id, text, kind }`. Answers come back via `answer_prompt`.
- `write_commit_graph` runs through `read`, not `write`: git locks the file itself, and holding the repository's write lock for the minute it can take would block every change.
- Window: `titleBarStyle: Overlay`, hidden title, min 950×640. The tab strip is the drag region (`core:window:allow-start-dragging`). Capabilities: `core:default`, window dragging and maximize, webview zoom, clipboard write, and dialog open and save.

### `src/` (UI)

- `api.ts`: typed wrappers in camelCase. They must match `tests.rs`, which calls with the same JSON.
- `workspace.ts`: tabs (repo or new-tab), restore and save, the palette's item list, and Preferences. It implements `Shell` for repository views.
  - Open, Clone and New repository (from the File menu, ⌘O, the palette or the toolbar's repo menu) run the shared flows in `welcome.ts`. They give the repository its own tab, just like + then picking it. A new-tab page in front is reused, an already-open repository just activates its tab, and cancelling changes nothing.
- `repo/repo-view.ts`: owns `snapshot` and `graph` and the selection. `refresh()` coalesces calls; it reloads the graph when asked, when HEAD moved, or when the WIP row appears or disappears. `run()` and `attempt()` give every operation the same feedback: progress toasts, conflicts explained, then a refresh.
- `repo/graph-view.ts`: the virtualized rows plus a canvas covering only the visible range. ROW 28 and LANE 20 roughly follow GitKraken's 28/22. Columns hide at container widths (sha < 980, date < 840, author < 680), and can be resized or hidden (saved in localStorage; graph width 0 = fit the lanes). Above the header: the filter bar (hidden/soloed refs) and the index bar (offered when `repoView.slowHistory` is set). `invalidate()` draws synchronously.
- `repo/detail-panel.ts`: the WIP staging lists, the composer (its draft survives refreshes; amend swaps in HEAD's message and back) and commit or stash details.
- `repo/diff-view.ts`: replaces the graph while open (Esc closes it). Click line numbers to select lines (⇧ for a range, one hunk at a time). Hunk buttons become "Stage N lines".
- `repo/actions.ts`: every operation with its dialogs, plus the ref, commit and multi-select context menus. `repo/extras-actions.ts` covers submodules, worktrees, LFS and Gitflow.
- Views that replace the graph (`repoView.showCenter`): `diff-view.ts`, `rebase-view.ts`, `merge-view.ts`, `history-view.ts`. `terminal-panel.ts` docks xterm under the graph; `ref-drag.ts` is label drag and drop. `repo/toolbar.ts` and `repo/ref-panel.ts` are the remaining pieces.
- `code/`: syntax highlighting with a hand-picked Prism build (`prism-manual.ts`, `syntax.ts`), word-level changes (`word-diff.ts`) and `render.ts`, which builds lines from tokens without `innerHTML`.
- `appearance.ts`: theme (Dracula, dark or light via `:root[data-theme]`, or system) and zoom (the webview zoom, in fixed steps). The theme is also cached in localStorage so a launch paints in it before the app data loads; Settings stay the source of truth.
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

Themes are token sets at the top of `src/styles.css`; components only read tokens (colors, radii, button and tab shapes, panel framing, the UI font), so a theme never needs selector overrides beyond Light's diff tints.
- **Dracula** (`:root`, the default; `DESIGN.md`, shared with Hostly): violet-dark surfaces, purple for actions and focus, green = added, orange = modified, red = removed or danger, cyan = renamed or links, pink = conflicts, live activity and scrollbars, yellow = search matches. Inter.
- **Light**: Dracula's shapes and meanings with darker, readable shades.
- **Dark** (`data-theme="dark"`): Spotify-inspired, near-black and achromatic with green as the one accent, pill buttons with uppercase labels, and rounded panels on a black frame. Figtree stands in for Circular.
- Match the system picks Dracula or Light. The store's `Theme` defaults to Dracula; data version 2 maps version 1's `dark` (which was Dracula) to `dracula`.
- What script colors follows `appearance.ts` `currentTheme()`: the eight graph lane colors per theme in `format.ts` `LANE_COLORS` (matching the core's `graph::COLORS`) and the terminal palettes in `terminal-panel.ts`; the graph canvas reads the tokens. `RepoView.themeChanged()` repaints them.
- Fonts via `@fontsource` (Inter, Figtree, JetBrains Mono), lucide icons via `src/icons.ts`.
- The logo: the owner's `logo.png` at the root is the source. Its corners are opaque black, so the derived copies are cut along the tile (at about x 46, y 45, 1162 px square, radius 285) with transparent corners:
  - `assets/app-icon.png`: 1024 px, the tile at 824 px with a shadow, for `npx tauri icon`;
  - `assets/logo.png`: 512 px, for the README;
  - `src/assets/logo.png`: 128 px, used by `src/brand.ts` `brandMark()` in the sidebar header and on the new-tab page.
