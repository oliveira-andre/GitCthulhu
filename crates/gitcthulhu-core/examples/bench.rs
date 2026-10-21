//! Times what opening and refreshing a repository costs, on any repository:
//!
//! ```sh
//! cargo run --release -p gitcthulhu-core --example bench -- ~/some/big/repo [limit]
//! ```
//!
//! Everything it runs only reads.

use std::path::PathBuf;
use std::time::Instant;

use gitcthulhu_core::git::Git;
use gitcthulhu_core::log::{self, GraphOptions, RefFilter};
use gitcthulhu_core::repo::Repo;
use gitcthulhu_core::{graph, refs, status};

fn time<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let value = f();
    println!(
        "{label:<28} {:>8.1} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    value
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = PathBuf::from(args.next().expect("usage: bench <repository> [limit]"));
    let limit: usize = args.next().map_or(2000, |n| n.parse().expect("limit"));
    let git = Git::find().expect("git");
    let repo = time("open", || Repo::open(&git, &path)).expect("open");

    println!("-- snapshot");
    time("head", || repo.head()).unwrap();
    time("state", || repo.state());
    let refs = time("refs", || refs::list(&repo)).unwrap();
    time("stashes", || log::stash_list(&repo)).unwrap();
    let status = time("status", || status::status(&repo)).unwrap();
    time("remotes", || repo.remotes()).unwrap();
    println!(
        "   {} refs, {} staged, {} unstaged",
        refs.len(),
        status.staged.len(),
        status.unstaged.len()
    );

    println!("-- graph of {limit}");
    let options = GraphOptions {
        limit,
        work_in_progress: true,
        filter: RefFilter::default(),
    };
    let loaded = time("log::load (log + layout)", || log::load(&repo, &options)).unwrap();
    let nodes: Vec<graph::Node> = loaded
        .commits
        .iter()
        .map(|c| graph::Node {
            oid: &c.oid,
            parents: &c.parents,
            dashed: false,
        })
        .collect();
    time("  layout alone", || graph::layout(&nodes));
    let json = time("  to JSON", || serde_json::to_string(&loaded)).unwrap();
    let lanes = loaded.rows.iter().map(|r| r.lane).max().unwrap_or(0) + 1;
    println!(
        "   {} commits, {lanes} lanes, {:.1} MB of JSON",
        loaded.commits.len(),
        json.len() as f64 / 1e6
    );

    let oids: Vec<String> = loaded
        .commits
        .iter()
        .skip(1)
        .take(60)
        .map(|c| c.oid.clone())
        .collect();
    time("commit_stats (60 rows)", || log::commit_stats(&repo, &oids)).unwrap();
    time("search 'fix'", || log::search(&repo, "fix", 200)).unwrap();
    // Nothing matches, so this reads the whole history: the worst case.
    time("search, no matches", || {
        log::search(&repo, "zq-no-such-text", 200)
    })
    .unwrap();
}
