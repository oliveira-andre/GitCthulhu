//! The person using the app: git's global name and email. Signing out
//! forgets them, and the passwords git's credential helper saved for the
//! HTTPS hosts of the open repositories' remotes.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::Git;
use crate::repo::Repo;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Global config isn't tied to a repository; run outside of any.
fn neutral_dir() -> PathBuf {
    std::env::temp_dir()
}

fn global_get(git: &Git, key: &str) -> Result<Option<String>> {
    let out = git.output(&neutral_dir(), &["config", "--global", "--get", key], None)?;
    Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|v| out.success() && !v.is_empty()))
}

pub fn load(git: &Git) -> Result<Profile> {
    Ok(Profile {
        name: global_get(git, "user.name")?,
        email: global_get(git, "user.email")?,
    })
}

/// Sets the global name and email, which every repository without its own
/// commits with.
pub fn save(git: &Git, name: &str, email: &str) -> Result<Profile> {
    let (name, email) = (name.trim(), email.trim());
    if name.is_empty() || email.is_empty() {
        return Err(Error::Invalid("enter both a name and an email".into()));
    }
    let dir = neutral_dir();
    git.run(&dir, &["config", "--global", "user.name", name])?;
    git.run(&dir, &["config", "--global", "user.email", email])?;
    load(git)
}

/// Forgets the global name and email when `identity` is set, and asks the
/// credential helper to erase what it saved for each of `hosts`
/// (`https://host`, as [`remote_hosts`] lists them).
pub fn sign_out(git: &Git, identity: bool, hosts: &[String]) -> Result<()> {
    for host in hosts {
        if !(host.starts_with("https://") || host.starts_with("http://"))
            || host.contains(['\n', '\0'])
        {
            return Err(Error::Invalid(format!("not a host: {host}")));
        }
    }
    let dir = neutral_dir();
    for host in hosts {
        git.run_input(
            &dir,
            &["credential", "reject"],
            format!("url={host}\n\n").as_bytes(),
        )?;
    }
    if identity {
        for key in ["user.name", "user.email"] {
            let out = git.output(&dir, &["config", "--global", "--unset-all", key], None)?;
            // 5: the key wasn't set.
            if !out.success() && out.code != Some(5) {
                return Err(Error::Git {
                    command: "config".into(),
                    code: out.code,
                    stderr: out.stderr,
                });
            }
        }
    }
    Ok(())
}

/// The HTTP(S) hosts the repository's remotes fetch from and push to, as
/// `https://host`. SSH remotes sign in with keys, so they aren't listed.
pub fn remote_hosts(repo: &Repo) -> Result<Vec<String>> {
    let out = repo.output(&["config", "--get-regexp", r"^remote\..*\.(url|pushurl)$"])?;
    let mut hosts: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.split_once(' ').and_then(|(_, url)| http_host(url)))
        .collect();
    hosts.sort();
    hosts.dedup();
    Ok(hosts)
}

/// `https://user:token@host:8443/a/b.git` → `https://host:8443`.
fn http_host(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    (!host.is_empty()).then(|| format!("{scheme}://{}", host.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_come_from_http_urls_only() {
        assert_eq!(
            http_host("https://github.com/owner/repo.git").as_deref(),
            Some("https://github.com")
        );
        assert_eq!(
            http_host("https://me:secret@GitLab.example.com:8443/a/b").as_deref(),
            Some("https://gitlab.example.com:8443")
        );
        assert_eq!(
            http_host("http://intranet/repo").as_deref(),
            Some("http://intranet")
        );
        assert_eq!(http_host("git@github.com:owner/repo.git"), None);
        assert_eq!(http_host("ssh://git@github.com/owner/repo"), None);
        assert_eq!(http_host("/srv/repos/a.git"), None);
    }
}
