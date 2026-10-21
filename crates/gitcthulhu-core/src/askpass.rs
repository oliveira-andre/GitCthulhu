//! Answers git's and ssh's prompts (usernames, passwords, key passphrases,
//! unknown host keys) from the app instead of a terminal.
//!
//! git and ssh run an askpass program with the prompt as its argument and
//! read the answer from its stdout. GitCthulhu's own executable is that
//! program: started with `GITCTHULHU_ASKPASS_PORT` set, it connects to the
//! running app over loopback, hands it the prompt, and prints the reply.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::git::Git;

const PORT_VAR: &str = "GITCTHULHU_ASKPASS_PORT";
const TOKEN_VAR: &str = "GITCTHULHU_ASKPASS_TOKEN";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub text: String,
    pub kind: PromptKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    Username,
    /// A password, passphrase or PIN: typed hidden.
    Secret,
    /// ssh asking whether to trust a host key.
    YesNo,
}

impl Prompt {
    pub fn new(text: &str) -> Prompt {
        let lower = text.to_ascii_lowercase();
        let kind = if lower.contains("(yes/no") {
            PromptKind::YesNo
        } else if lower.starts_with("username") {
            PromptKind::Username
        } else {
            PromptKind::Secret
        };
        Prompt {
            text: text.trim().to_owned(),
            kind,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Reply {
    answer: Option<String>,
}

pub type Handler = Arc<dyn Fn(Prompt) -> Option<String> + Send + Sync>;

/// Listens for askpass helpers for as long as the app runs.
pub struct AskpassServer {
    port: u16,
    token: String,
}

impl AskpassServer {
    /// `handler` blocks until the user answers; `None` cancels the prompt.
    pub fn start(handler: Handler) -> Result<AskpassServer> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let token = random_token()?;
        let expected = token.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let handler = handler.clone();
                let expected = expected.clone();
                std::thread::spawn(move || {
                    let _ = serve(stream, &expected, &handler);
                });
            }
        });
        Ok(AskpassServer { port, token })
    }

    /// Points git and ssh at `helper` (this app's executable).
    pub fn configure(&self, git: Git, helper: &Path) -> Git {
        git.with_env("GIT_ASKPASS", helper)
            .with_env("SSH_ASKPASS", helper)
            // Use askpass even when started from a terminal.
            .with_env("SSH_ASKPASS_REQUIRE", "force")
            .with_env(PORT_VAR, self.port.to_string())
            .with_env(TOKEN_VAR, &self.token)
    }
}

fn serve(stream: TcpStream, expected: &str, handler: &Handler) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let Ok(request) = serde_json::from_str::<Request>(&line) else {
        return Ok(());
    };
    // Only helpers started by this app know the token.
    let answer = if request.token == expected {
        handler(Prompt::new(&request.prompt))
    } else {
        None
    };
    let mut stream = stream;
    stream.write_all(serde_json::to_string(&Reply { answer })?.as_bytes())?;
    stream.write_all(b"\n")
}

/// When this process was started as git's or ssh's askpass helper, answers
/// the prompt and returns the exit code; otherwise returns `None` and the
/// app starts normally. Call it first thing in `main`.
pub fn run_if_helper() -> Option<i32> {
    let port: u16 = std::env::var(PORT_VAR).ok()?.parse().ok()?;
    let token = std::env::var(TOKEN_VAR).unwrap_or_default();
    let prompt = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "Password:".to_owned());
    Some(match ask(port, &token, &prompt) {
        Ok(Some(answer)) => {
            println!("{answer}");
            0
        }
        _ => 1,
    })
}

fn ask(port: u16, token: &str, prompt: &str) -> std::io::Result<Option<String>> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
    let request = serde_json::to_string(&Request {
        token: token.to_owned(),
        prompt: prompt.to_owned(),
    })?;
    stream.write_all(request.as_bytes())?;
    stream.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    let reply: Reply = serde_json::from_str(&line)?;
    Ok(reply.answer)
}

fn random_token() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_prompts() {
        assert_eq!(
            Prompt::new("Username for 'https://github.com': ").kind,
            PromptKind::Username
        );
        assert_eq!(
            Prompt::new("Password for 'https://me@github.com': ").kind,
            PromptKind::Secret
        );
        assert_eq!(
            Prompt::new("Enter passphrase for key '/home/me/.ssh/id_ed25519': ").kind,
            PromptKind::Secret
        );
        assert_eq!(
            Prompt::new("Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
                .kind,
            PromptKind::YesNo
        );
    }

    #[test]
    fn a_helper_with_the_token_gets_the_answer() {
        let server =
            AskpassServer::start(Arc::new(|p: Prompt| Some(format!("answer to {}", p.text))))
                .unwrap();
        let answer = ask(server.port, &server.token, "Password: ").unwrap();
        assert_eq!(answer.as_deref(), Some("answer to Password:"));
        let refused = ask(server.port, "wrong", "Password: ").unwrap();
        assert_eq!(refused, None);
    }
}
