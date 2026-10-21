# GitKraken 12.6.0 as a feature reference

What GitCthulhu learned from the shipped GitKraken Desktop 12.6.0 (macOS arm64,
`/Applications/GitKraken.app`, `app.asar` sha256 `4daf5e68…9702`). It is a
feature and behaviour reference only. No GitKraken code, assets, themes or
strings are used in GitCthulhu.

## How it was gathered

- REA `analyze_javascript_application` on `app.asar` (summary detail,
  `integrity_policy: record-and-continue`; the 24 integrity mismatches are all
  unpacked, code-signed binaries). Parent Evidence
  `ev_b17baf350d9df5d96f3d53034c8dd4ad470a545ec88ca26e670f8c3968ceacf3`.
  Even the summary exceeded MCP's 10 MB frame. The bundle was exported (1.37 GB)
  and queried locally.
- REA's graph is thin for GitKraken's own code. Semantic analysis ran out of budget
  for ~32k files, and the main-process bundles reach Electron through webpack
  module ids, so they record no Electron facts. Most details below come from
  reading bundle text and the plain JSON/JSONC files inside the asar. They are
  observed in the shipped bytes but not executed.

## Architecture (observed)

- Electron, React + Redux + redux-saga. Main process `src/main/static/main.bundle.js`;
  renderer `render.bundle.js` (12.8 MB); a hidden request-handler WebContentsView
  for HTTP; web workers for commit search (MiniSearch over message, author,
  authorEmail, sha), font detection and a diff3 merge pool. A forked pty-host
  runs node-pty.
- Git: a bundled git CLI (`git/bin/git`, plus git-lfs) does nearly every write and
  network operation: `fetch`, `pull`, `push`, `rebase`, `merge`, `cherry-pick`,
  `revert`, `reset`, `stash push/apply/drop/list`, `commit --file=-`, `apply`,
  `clone`, `worktree`, `submodule`, `lfs`. nodegit (libgit2) handles some reads.
  The graph comes from `git rev-list --format=tformat:%x00 %P%x00 %an%x00 %ae%x00 %at%x00 %cn%x00 %ce%x00 %ct%x00 %B%x00%x00 … --stdin`.
- Credentials: `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS` point at a helper,
  which is the app binary run as node (`AskPass.sh`). It relays prompts to the
  app over a local socket. Interactive rebase sets `GIT_SEQUENCE_EDITOR` to a
  similar helper, so the app edits the todo list. GPG signing passes
  `-c gpg.program=<askpass>`.
- IPC: ~333 saga-handler channels (`ipcMain.handle`) in 42 groups, plus 83
  `Service.method` channels.
- Window: `titleBarStyle: hidden` on macOS, traffic lights at {8,14}, min
  950×675, default 1024×800. Deep links: `gitkraken://` (repo, repolink,
  drafts, login, token, preferences, workspaces). It uses a custom socket lock
  for single instance.

## Commit graph (observed in the bundled graph component)

- Rows 28 px (22 px inner), header 26 px. Lanes 22 px wide, 2 px lines,
  22 px commit nodes (avatars), 12 px merge nodes, arc radius 11.
- Lane colour `graph-color-(column % 10)`; ten colours per theme.
- Default column widths: ref 130, graph 150, message 300, author 130,
  changes 200, date/time 130, sha 130. Each column is its own virtualized grid
  sharing a scrollTop.
- A WIP node sits on top. Stashes show as nodes in the graph.

## Feature inventory (from the UI strings and menus)

Core git: graph with branch/tag labels and soloing/hiding; left panel sections
(Local, Remote, Pull Requests, Issues, Tags, Stashes, Submodules, Worktrees,
Cloud Patches, Gitflow, Teams, Agents); commit details panel; unstaged/staged/
conflicted file lists (path or tree view); hunk and line staging; commit
composer (summary + description, amend, AI message); merge tool (A/B/output,
take line or chunk); interactive rebase panel (pick, reword, squash, drop,
move up/down); undo/redo; file history and blame; commit search; fuzzy finder
(commands, repos, history); tabs and favorites; embedded terminal; LFS; GPG;
Gitflow; submodules; worktrees; sparse checkout; shallow clone; hooks.

Platform: GitHub, GitLab, Bitbucket, Azure DevOps and Jira integrations; pull
requests; issues; workspaces; cloud patches; AI features; accounts and trial
gating. These are out of scope for GitCthulhu.

Pull options: Fetch All; Pull (fast-forward if possible); Pull (fast-forward
only); Pull (rebase). Auto-stash messages: "Auto stash before checking out
…", "…before merge of … and …", "…before rebase of … onto …", and so on.

## Default key bindings (`src/keyBindings/shared.json`)

| Keys | Action |
|---|---|
| ⌘B | create branch |
| ⌘/ | show key bindings |
| ⌘D | open file in external diff tool |
| ⌘F | search commits |
| ⌘⇧O | fuzzy finder: open repo |
| ⌘⇧P | fuzzy finder |
| ⌘⌥F | focus left panel filter |
| ⌘Z / ⌘⇧Z, ⌘Y | undo / redo |
| ↑ ↓, k j | previous / next commit (⇧ for topological) |
| d p r | interactive rebase: drop / pick / reword |
| s, u | stage / unstage the selected file |
| ⌘⇧S / ⌘⇧U | stage all / unstage all |
| ⌘⇧M | focus commit message |
| ⌘↩ / ⌘⇧↩ | commit / stage all and commit |
| ⌘L | fetch |
| ⌘⇧T | reopen closed tab |
| ⌘J / ⌘K | toggle left panel / detail panel |
| ⌘⇧H | fuzzy finder: file history |
| ⌘S | merge tool: save and resolve |
| Esc | close |
