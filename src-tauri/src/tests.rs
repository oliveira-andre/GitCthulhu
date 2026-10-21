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
