//! Drives the commands through Tauri's IPC layer with the same JSON the UI
//! sends (see src/api.ts), so a renamed argument fails here rather than in
//! the app.

use std::path::Path;
use std::sync::Arc;

use gitcthulhu_core::Git;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

use crate::state::AppState;

struct Harness {
    _app: App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    dir: tempfile::TempDir,
}

fn test_git(dir: &Path) -> Git {
    let config = dir.join("gitconfig");
    std::fs::write(
        &config,
        "[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
    )
    .unwrap();
    Git::find()
        .unwrap()
        .with_env("GIT_CONFIG_GLOBAL", &config)
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let git = test_git(dir.path());
    let state = AppState::open(&dir.path().join("data"), Ok(git), Arc::new(|_, _| true)).unwrap();
    let app = mock_builder()
        .manage(state)
        .invoke_handler(crate::handlers!())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Harness {
        _app: app,
        webview,
        dir,
    }
}

impl Harness {
    fn call(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    }

    fn ok<T: DeserializeOwned>(&self, cmd: &str, args: Value) -> T {
        match self.call(cmd, args) {
            Ok(value) => serde_json::from_value(value).unwrap(),
            Err(error) => panic!("{cmd} failed: {error}"),
        }
    }

    fn git(&self, repo: &Path, args: &[&str]) -> String {
        let git = test_git(self.dir.path());
        git.run_text(repo, args).unwrap()
    }
}

#[test]
fn the_ui_flow_works_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");

    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    assert_eq!(info["name"], "repo");

    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    let snapshot: Value = h.ok("snapshot", json!({ "id": id }));
    assert_eq!(snapshot["status"]["unstaged"][0]["path"], "a.txt");
    assert_eq!(snapshot["status"]["unstaged"][0]["kind"], "untracked");
    assert_eq!(snapshot["state"]["kind"], "clean");

    let _: () = h.ok("stage", json!({ "id": id, "paths": ["a.txt"] }));
    let oid: String = h.ok(
        "commit",
        json!({ "id": id, "message": "First\n\nBody", "amend": false }),
    );
    assert_eq!(oid.len(), 40);

    let graph: Value = h.ok(
        "load_graph",
        json!({ "id": id, "limit": 100, "workInProgress": false }),
    );
    assert_eq!(graph["commits"][0]["subject"], "First");
    assert_eq!(graph["rows"][0]["lane"], 0);

    let details: Value = h.ok("commit_details", json!({ "id": id, "oid": oid }));
    assert_eq!(details["body"], "Body");
    assert_eq!(details["files"][0]["kind"], "added");

    // Stage one line of a two-line change, as the diff view does.
    std::fs::write(repo.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
    let diff: Value = h.ok(
        "file_diff",
        json!({ "id": id, "target": { "kind": "unstaged" }, "path": "a.txt", "oldPath": null, "context": 3 }),
    );
    let header = diff["hunks"][0]["header"].as_str().unwrap().to_owned();
    let lines = diff["hunks"][0]["lines"].as_array().unwrap();
    let three = lines.iter().position(|l| l["text"] == "three").unwrap();
    let _: () = h.ok(
        "apply_lines",
        json!({ "id": id, "action": "stage", "path": "a.txt", "hunk": 0, "hunkHeader": header, "lines": [three] }),
    );
    assert_eq!(h.git(&repo, &["show", ":a.txt"]), "one\ntwo\nthree\n");
    let _: () = h.ok("unstage_all", json!({ "id": id }));
    let _: () = h.ok("discard", json!({ "id": id, "paths": ["a.txt"] }));

    let _: () = h.ok(
        "create_branch",
        json!({ "id": id, "name": "topic", "at": null, "checkout": true }),
    );
    let _: () = h.ok(
        "rename_branch",
        json!({ "id": id, "old": "topic", "new": "renamed" }),
    );
    let _: () = h.ok("checkout_branch", json!({ "id": id, "name": "main" }));
    let _: () = h.ok(
        "delete_branch",
        json!({ "id": id, "name": "renamed", "force": false }),
    );
    let _: () = h.ok(
        "create_tag",
        json!({ "id": id, "name": "v1", "at": oid, "message": "Release" }),
    );

    std::fs::write(repo.join("a.txt"), "stashed\n").unwrap();
    let _: () = h.ok(
        "stash_push",
        json!({ "id": id, "message": "parked", "includeUntracked": true }),
    );
    let snapshot: Value = h.ok("snapshot", json!({ "id": id }));
    assert_eq!(snapshot["stashes"][0]["name"], "stash@{0}");
    let _: () = h.ok(
        "stash_apply",
        json!({ "id": id, "stash": "stash@{0}", "pop": true }),
    );
    let file: String = h.ok("worktree_file", json!({ "id": id, "path": "a.txt" }));
    assert_eq!(file, "stashed\n");

    let _: () = h.ok("stage_all", json!({ "id": id }));
    let amended: String = h.ok(
        "commit",
        json!({ "id": id, "message": "First, amended", "amend": true }),
    );
    assert_ne!(amended, oid);
    let message: String = h.ok("head_message", json!({ "id": id }));
    assert_eq!(message, "First, amended");

    let _: () = h.ok("reset", json!({ "id": id, "oid": amended, "mode": "hard" }));
    let remote: Option<String> = h.ok("default_remote", json!({ "id": id }));
    assert_eq!(remote, None);

    let data: Value = h.ok("save_tabs", json!({ "tabs": [repo], "active": repo }));
    assert_eq!(data["recent"][0]["name"], "repo");
    let _: () = h.ok("close_repo", json!({ "id": id }));
}

#[test]
fn errors_carry_a_kind_for_the_ui() {
    let h = harness();
    let error = h.call("snapshot", json!({ "id": "/nowhere" })).unwrap_err();
    assert_eq!(error["kind"], "notOpen");

    let not_repo = h.dir.path().join("plain");
    std::fs::create_dir_all(&not_repo).unwrap();
    let error = h
        .call("open_repo", json!({ "path": not_repo }))
        .unwrap_err();
    assert_eq!(error["kind"], "notARepository");
}

#[test]
fn worktree_file_stays_inside_the_repository() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": null }));
    std::fs::write(h.dir.path().join("secret.txt"), "no").unwrap();
    let error = h
        .call(
            "worktree_file",
            json!({ "id": info["id"], "path": "../secret.txt" }),
        )
        .unwrap_err();
    assert_eq!(error["kind"], "invalid");
}

#[test]
fn interactive_rebase_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    let mut oids = Vec::new();
    for name in ["base", "one", "two", "three"] {
        std::fs::write(repo.join(format!("{name}.txt")), name).unwrap();
        let _: () = h.ok("stage_all", json!({ "id": id }));
        oids.push(h.ok::<String>(
            "commit",
            json!({ "id": id, "message": name, "amend": false }),
        ));
    }

    let plan: Vec<Value> = h.ok("rebase_plan", json!({ "id": id, "onto": oids[0] }));
    assert_eq!(
        plan.iter()
            .map(|c| c["summary"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["one", "two", "three"]
    );
    let steps = json!([
        { "oid": oids[2], "action": "pick" },
        { "oid": oids[1], "action": "reword", "message": "one, reworded" },
        { "oid": oids[3], "action": "fixup" },
    ]);
    let _: () = h.ok(
        "interactive_rebase",
        json!({ "id": id, "onto": oids[0], "steps": steps }),
    );
    let log = h.git(&repo, &["log", "--format=%s", "--reverse"]);
    assert_eq!(
        log.lines().collect::<Vec<_>>(),
        ["base", "two", "one, reworded"]
    );

    let head = h.git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let _: () = h.ok(
        "reword_commit",
        json!({ "id": id, "oid": head, "message": "renamed" }),
    );
    let head = h.git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let _: () = h.ok("move_commit", json!({ "id": id, "oid": head, "up": false }));
    let head = h.git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let _: () = h.ok("drop_commit", json!({ "id": id, "oid": head }));
    let log = h.git(&repo, &["log", "--format=%s", "--reverse"]);
    assert_eq!(log.lines().collect::<Vec<_>>(), ["base", "renamed"]);
}

#[test]
fn undo_and_redo_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    std::fs::write(repo.join("a.txt"), "1\n").unwrap();
    let _: () = h.ok("stage_all", json!({ "id": id }));
    let _: String = h.ok(
        "commit",
        json!({ "id": id, "message": "first", "amend": false }),
    );
    let _: () = h.ok(
        "create_branch",
        json!({ "id": id, "name": "topic", "at": null, "checkout": true }),
    );

    let snapshot: Value = h.ok("snapshot", json!({ "id": id }));
    assert_eq!(snapshot["undo"]["undo"], "Create topic");
    let undone: String = h.ok("undo", json!({ "id": id }));
    assert_eq!(undone, "Create topic");
    let snapshot: Value = h.ok("snapshot", json!({ "id": id }));
    assert_eq!(snapshot["head"]["branch"], "main");
    assert_eq!(
        snapshot["undo"],
        json!({ "undo": "Commit", "redo": "Create topic" })
    );
    let redone: String = h.ok("redo", json!({ "id": id }));
    assert_eq!(redone, "Create topic");

    // Discards come back.
    std::fs::write(repo.join("a.txt"), "precious\n").unwrap();
    let _: () = h.ok("discard", json!({ "id": id, "paths": ["a.txt"] }));
    let _: String = h.ok("undo", json!({ "id": id }));
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).unwrap(),
        "precious\n"
    );

    let error = h.call("redo", json!({ "id": id })).map(|_| ()).err();
    assert!(
        error.is_none(),
        "redo of the discard is available: {error:?}"
    );
}

#[test]
fn merge_tool_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    let commit = |contents: &str, message: &str| {
        std::fs::write(repo.join("a.txt"), contents).unwrap();
        let _: () = h.ok("stage_all", json!({ "id": id }));
        let _: String = h.ok(
            "commit",
            json!({ "id": id, "message": message, "amend": false }),
        );
    };
    commit("top\nmiddle\nbottom\n", "base");
    let _: () = h.ok(
        "create_branch",
        json!({ "id": id, "name": "other", "at": null, "checkout": true }),
    );
    commit("top\nTHEIRS\nbottom\n", "theirs");
    let _: () = h.ok("checkout_branch", json!({ "id": id, "name": "main" }));
    commit("top\nOURS\nbottom\n", "ours");
    let error = h
        .call(
            "merge",
            json!({ "id": id, "other": "other", "mode": "default" }),
        )
        .unwrap_err();
    assert_eq!(error["kind"], "conflicts");

    let file: Value = h.ok("conflict_file", json!({ "id": id, "path": "a.txt" }));
    assert_eq!(file["segments"][1]["kind"], "conflict");
    assert_eq!(file["segments"][1]["ours"], json!(["OURS"]));
    assert_eq!(file["segments"][1]["theirs"], json!(["THEIRS"]));
    let _: () = h.ok(
        "resolve_file",
        json!({ "id": id, "path": "a.txt", "contents": "top\nOURS\nTHEIRS\nbottom\n" }),
    );
    let _: () = h.ok("sequence", json!({ "id": id, "action": "continue" }));
    let snapshot: Value = h.ok("snapshot", json!({ "id": id }));
    assert_eq!(snapshot["state"]["kind"], "clean");
    // The finished merge is one undoable step.
    assert_eq!(snapshot["undo"]["undo"], "Merge other");
}

#[test]
fn several_commits_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    let mut oids = Vec::new();
    for name in ["one", "two", "three"] {
        std::fs::write(repo.join(format!("{name}.txt")), name).unwrap();
        let _: () = h.ok("stage_all", json!({ "id": id }));
        oids.push(h.ok::<String>(
            "commit",
            json!({ "id": id, "message": name, "amend": false }),
        ));
    }
    let files: Vec<Value> = h.ok(
        "compare_files",
        json!({ "id": id, "from": oids[0], "to": oids[2] }),
    );
    assert_eq!(files.len(), 2);
    let diff: Value = h.ok(
        "file_diff",
        json!({ "id": id, "target": { "kind": "range", "from": oids[0], "to": oids[2] }, "path": "two.txt", "oldPath": null, "context": 3 }),
    );
    assert_eq!(diff["newFile"], true);
    // Newest first, as the graph selects them.
    let _: () = h.ok(
        "revert_commits",
        json!({ "id": id, "oids": [oids[2], oids[1]] }),
    );
    assert!(!repo.join("three.txt").exists() && !repo.join("two.txt").exists());
    let snapshot: Value = h.ok("snapshot", json!({ "id": id }));
    assert_eq!(snapshot["undo"]["undo"], "Revert 2 commits");
}

#[test]
fn file_history_and_blame_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    for (contents, message) in [("one\n", "create"), ("one\ntwo\n", "grow")] {
        std::fs::write(repo.join("f.txt"), contents).unwrap();
        let _: () = h.ok("stage_all", json!({ "id": id }));
        let _: String = h.ok(
            "commit",
            json!({ "id": id, "message": message, "amend": false }),
        );
    }
    let history: Vec<Value> = h.ok(
        "file_history",
        json!({ "id": id, "path": "f.txt", "limit": 50 }),
    );
    assert_eq!(
        history
            .iter()
            .map(|c| c["subject"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["grow", "create"]
    );
    assert_eq!(history[1]["kind"], "added");
    let blame: Value = h.ok("blame", json!({ "id": id, "path": "f.txt", "rev": null }));
    assert_eq!(blame["lines"][1]["text"], "two");
    assert_eq!(blame["lines"][1]["oid"], history[0]["oid"]);
    let files: Vec<String> = h.ok("tracked_files", json!({ "id": id }));
    assert_eq!(files, ["f.txt"]);
}

#[test]
fn image_diffs_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    std::fs::write(repo.join("dot.png"), b"PNG!").unwrap();
    let url: Option<String> = h.ok(
        "file_image",
        json!({ "id": id, "source": { "kind": "worktree" }, "path": "dot.png" }),
    );
    assert_eq!(url.as_deref(), Some("data:image/png;base64,UE5HIQ=="));
    let missing: Option<String> = h.ok(
        "file_image",
        json!({ "id": id, "source": { "kind": "index" }, "path": "dot.png" }),
    );
    assert_eq!(missing, None);
    let error = h
        .call(
            "file_image",
            json!({ "id": id, "source": { "kind": "worktree" }, "path": "notes.txt" }),
        )
        .unwrap_err();
    assert_eq!(error["kind"], "invalid");
    let diff: Value = h.ok(
        "file_diff",
        json!({ "id": id, "target": { "kind": "unstaged" }, "path": "dot.png", "oldPath": null, "context": 3, "ignoreWhitespace": true }),
    );
    assert_eq!(diff["newFile"], true);
}

#[test]
fn extras_and_gitflow_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    std::fs::write(repo.join("a.txt"), "a").unwrap();
    let _: () = h.ok("stage_all", json!({ "id": id }));
    let _: String = h.ok(
        "commit",
        json!({ "id": id, "message": "base", "amend": false }),
    );

    let extras: Value = h.ok("extras", json!({ "id": id }));
    assert_eq!(extras["submodules"], json!([]));
    assert_eq!(extras["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(extras["gitflow"], Value::Null);

    let config = json!({ "production": "main", "develop": "develop", "feature": "feature/", "release": "release/", "hotfix": "hotfix/", "versionTag": "v" });
    let _: () = h.ok("gitflow_init", json!({ "id": id, "config": config }));
    let branch: String = h.ok(
        "gitflow_start",
        json!({ "id": id, "kind": "feature", "name": "x" }),
    );
    assert_eq!(branch, "feature/x");
    std::fs::write(repo.join("x.txt"), "x").unwrap();
    let _: () = h.ok("stage_all", json!({ "id": id }));
    let _: String = h.ok(
        "commit",
        json!({ "id": id, "message": "x", "amend": false }),
    );
    let _: () = h.ok(
        "gitflow_finish",
        json!({ "id": id, "kind": "feature", "name": "x", "tagMessage": null }),
    );
    let extras: Value = h.ok("extras", json!({ "id": id }));
    assert_eq!(extras["gitflow"]["develop"], "develop");
    let snapshot: Value = h.ok("snapshot", json!({ "id": id }));
    assert_eq!(snapshot["head"]["branch"], "develop");
    assert_eq!(snapshot["undo"]["undo"], "Finish feature x");
    // Undoing the finish brings the feature branch back, checked out.
    let _: String = h.ok("undo", json!({ "id": id }));
    let snapshot: Value = h.ok("snapshot", json!({ "id": id }));
    assert_eq!(snapshot["head"]["branch"], "feature/x");

    let worktree = h.dir.path().join("second");
    let _: () = h.ok(
        "worktree_add",
        json!({ "id": id, "path": worktree, "branch": "side", "create": true, "start": null }),
    );
    let extras: Value = h.ok("extras", json!({ "id": id }));
    assert_eq!(extras["worktrees"].as_array().unwrap().len(), 2);
    let _: () = h.ok(
        "worktree_remove",
        json!({ "id": id, "path": worktree, "force": false }),
    );
}

#[cfg(unix)]
#[test]
fn terminal_commands_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    let session: u64 = h.ok(
        "terminal_open",
        json!({ "id": id, "cols": 80, "rows": 24, "onOutput": "__CHANNEL__:1", "onExit": "__CHANNEL__:2" }),
    );
    let _: () = h.ok(
        "terminal_resize",
        json!({ "session": session, "cols": 100, "rows": 30 }),
    );
    let _: () = h.ok(
        "terminal_write",
        json!({ "session": session, "data": b"exit\r".to_vec() }),
    );
    let _: () = h.ok("terminal_close", json!({ "session": session }));
    let error = h
        .call(
            "terminal_resize",
            json!({ "session": session, "cols": 1, "rows": 1 }),
        )
        .unwrap_err();
    assert_eq!(error["kind"], "notOpen");
}

#[test]
fn graph_controls_through_ipc() {
    let h = harness();
    let repo = h.dir.path().join("repo");
    let info: Value = h.ok("init_repo", json!({ "path": repo, "branch": "main" }));
    let id = info["id"].as_str().unwrap().to_owned();
    std::fs::write(repo.join("a.txt"), "1\n2\n").unwrap();
    let _: () = h.ok("stage_all", json!({ "id": id }));
    let base: String = h.ok(
        "commit",
        json!({ "id": id, "message": "base", "amend": false }),
    );
    let _: () = h.ok(
        "create_branch",
        json!({ "id": id, "name": "side", "at": null, "checkout": true }),
    );
    std::fs::write(repo.join("b.txt"), "b\n").unwrap();
    let _: () = h.ok("stage_all", json!({ "id": id }));
    let _: String = h.ok(
        "commit",
        json!({ "id": id, "message": "Side quest", "amend": false }),
    );
    let _: () = h.ok("checkout_branch", json!({ "id": id, "name": "main" }));

    let filter = json!({ "hidden": ["refs/heads/side"], "solo": [], "hideStashes": false });
    let graph: Value = h.ok(
        "load_graph",
        json!({ "id": id, "limit": 50, "workInProgress": false, "filter": filter }),
    );
    assert_eq!(graph["commits"].as_array().unwrap().len(), 1);
    assert_eq!(graph["indexed"], false);
    let _: () = h.ok(
        "write_commit_graph",
        json!({ "id": id, "onProgress": "__CHANNEL__:1" }),
    );
    let graph: Value = h.ok(
        "load_graph",
        json!({ "id": id, "limit": 50, "workInProgress": false, "filter": null }),
    );
    assert_eq!(graph["indexed"], true);
    let stats: Vec<Value> = h.ok("commit_stats", json!({ "id": id, "oids": [base] }));
    assert_eq!(stats[0]["insertions"], 2);
    let found: Vec<Value> = h.ok(
        "search_commits",
        json!({ "id": id, "query": "quest", "limit": 10 }),
    );
    assert_eq!(found[0]["subject"], "Side quest");
}
