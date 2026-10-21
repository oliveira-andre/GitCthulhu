//! Runs the git command line. GitCthulhu reads and changes repositories only
//! through git itself, so hooks, signing, credential helpers and the user's
//! config all behave exactly as they do in a terminal.

use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::{Error, Result};

#[derive(Debug, Clone)]
pub struct Git {
    exe: PathBuf,
    env: Vec<(OsString, OsString)>,
}

/// What a git process printed, for commands whose exit code isn't simply
/// success or failure.
#[derive(Debug)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

impl Git {
    /// Finds git: `GITCTHULHU_GIT`, then `PATH`, then the usual install
    /// locations, since apps started from the Dock get a minimal `PATH`.
    pub fn find() -> Result<Git> {
        if let Some(exe) = std::env::var_os("GITCTHULHU_GIT") {
            return Ok(Git::at(exe));
        }
        let name = if cfg!(windows) { "git.exe" } else { "git" };
        let from_path = std::env::var_os("PATH")
            .map(|paths| {
                std::env::split_paths(&paths)
                    .map(|dir| dir.join(name))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let fallbacks: &[&str] = if cfg!(windows) {
            &[
                r"C:\Program Files\Git\cmd\git.exe",
                r"C:\Program Files (x86)\Git\cmd\git.exe",
            ]
        } else {
            &[
                "/opt/homebrew/bin/git",
                "/usr/local/bin/git",
                "/usr/bin/git",
                "/opt/local/bin/git",
            ]
        };
        from_path
            .into_iter()
            .chain(fallbacks.iter().map(PathBuf::from))
            .find(|exe| exe.is_file())
            .map(Git::at)
            .ok_or(Error::GitNotFound)
    }

    pub fn at(exe: impl Into<PathBuf>) -> Git {
        Git {
            exe: exe.into(),
            env: Vec::new(),
        }
    }

    pub fn exe(&self) -> &Path {
        &self.exe
    }

    /// Adds an environment variable to every git process, for example the
    /// askpass helper.
    pub fn with_env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Git {
        self.env
            .push((key.as_ref().to_owned(), value.as_ref().to_owned()));
        self
    }

    pub fn version(&self) -> Result<String> {
        let out = self.run(Path::new("."), &["--version"])?;
        Ok(String::from_utf8_lossy(&out).trim().to_owned())
    }

    /// A git command in `dir` that never waits for a terminal: prompts go to
    /// the askpass helper (or fail), and editors are replaced with a no-op.
    pub fn command(&self, dir: &Path) -> Command {
        let mut cmd = Command::new(&self.exe);
        cmd.current_dir(dir)
            .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_EDITOR", "true")
            .env("GIT_PAGER", "cat")
            .env("LANGUAGE", "C")
            .env("LC_MESSAGES", "C")
            .env_remove("LC_ALL")
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    /// Runs git and returns its stdout, failing on a non-zero exit.
    pub fn run<S: AsRef<OsStr>>(&self, dir: &Path, args: &[S]) -> Result<Vec<u8>> {
        checked(args, self.output(dir, args, None)?)
    }

    /// Like [`Git::run`], with `input` written to git's stdin.
    pub fn run_input<S: AsRef<OsStr>>(
        &self,
        dir: &Path,
        args: &[S],
        input: &[u8],
    ) -> Result<Vec<u8>> {
        checked(args, self.output(dir, args, Some(input))?)
    }

    pub fn run_text<S: AsRef<OsStr>>(&self, dir: &Path, args: &[S]) -> Result<String> {
        let out = self.run(dir, args)?;
        String::from_utf8(out).map_err(|e| Error::Parse(e.to_string()))
    }

    /// Runs git and reports how it exited, without treating failure as an error.
    pub fn output<S: AsRef<OsStr>>(
        &self,
        dir: &Path,
        args: &[S],
        input: Option<&[u8]>,
    ) -> Result<Output> {
        let mut cmd = self.command(dir);
        cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
        if input.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::GitNotFound,
            _ => Error::Io(e),
        })?;

        // Write stdin and drain stderr on their own threads, so a large
        // input or a chatty stderr can't deadlock against stdout.
        let writer = input.map(|input| {
            let mut stdin = child.stdin.take().expect("piped stdin");
            let input = input.to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&input);
            })
        });
        let mut stderr_pipe = child.stderr.take().expect("piped stderr");
        let stderr_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr_pipe.read_to_end(&mut buf);
            buf
        });

        let mut stdout = Vec::new();
        child
            .stdout
            .take()
            .expect("piped stdout")
            .read_to_end(&mut stdout)?;
        let status = child.wait()?;
        if let Some(writer) = writer {
            let _ = writer.join();
        }
        let stderr = stderr_reader.join().unwrap_or_default();
        Ok(Output {
            code: status.code(),
            stdout,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }
}

impl Git {
    /// Runs git and hands each NUL-terminated record of its stdout to
    /// `record` as it arrives. Returning `false` stops git there, so a walk
    /// over a long history ends as soon as it has found enough.
    pub fn stream<S: AsRef<OsStr>>(
        &self,
        dir: &Path,
        args: &[S],
        record: &mut dyn FnMut(&[u8]) -> bool,
    ) -> Result<()> {
        let mut cmd = self.command(dir);
        cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::GitNotFound,
            _ => Error::Io(e),
        })?;
        let mut stderr_pipe = child.stderr.take().expect("piped stderr");
        let stderr_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr_pipe.read_to_end(&mut buf);
            buf
        });
        let mut reader = BufReader::new(child.stdout.take().expect("piped stdout"));
        let mut buf = Vec::new();
        let mut stopped = false;
        let read = loop {
            buf.clear();
            match reader.read_until(0, &mut buf) {
                Ok(0) => break Ok(()),
                Ok(_) => {}
                Err(e) => break Err(e),
            }
            if buf.last() == Some(&0) {
                buf.pop();
            }
            if !buf.is_empty() && !record(&buf) {
                stopped = true;
                break Ok(());
            }
        };
        if stopped || read.is_err() {
            let _ = child.kill();
        }
        drop(reader);
        let status = child.wait()?;
        let stderr = stderr_reader.join().unwrap_or_default();
        read?;
        if stopped {
            return Ok(());
        }
        checked(
            args,
            Output {
                code: status.code(),
                stdout: Vec::new(),
                stderr: lossy(&stderr),
            },
        )
        .map(drop)
    }

    /// Runs a long command (clone, fetch, pull, push) with `--progress`,
    /// passing each progress line to `progress` as git prints it. git ends
    /// progress updates with `\r`, so both `\r` and `\n` end a line.
    pub fn run_progress<S: AsRef<OsStr>>(
        &self,
        dir: &Path,
        args: &[S],
        progress: &mut dyn FnMut(&str),
    ) -> Result<Vec<u8>> {
        let mut cmd = self.command(dir);
        cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::GitNotFound,
            _ => Error::Io(e),
        })?;
        let mut stdout_pipe = child.stdout.take().expect("piped stdout");
        let stdout_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout_pipe.read_to_end(&mut buf);
            buf
        });

        let mut stderr_pipe = child.stderr.take().expect("piped stderr");
        let mut stderr = Vec::new();
        let mut line = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stderr_pipe.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            stderr.extend_from_slice(&chunk[..n]);
            for &b in &chunk[..n] {
                if b == b'\r' || b == b'\n' {
                    if !line.is_empty() {
                        progress(&String::from_utf8_lossy(&line));
                        line.clear();
                    }
                } else {
                    line.push(b);
                }
            }
        }
        let status = child.wait()?;
        let stdout = stdout_reader.join().unwrap_or_default();
        // Keep only final lines in the error: drop the `\r` progress updates.
        let stderr = String::from_utf8_lossy(&stderr)
            .split('\n')
            .map(|l| l.rsplit('\r').next().unwrap_or(l))
            .collect::<Vec<_>>()
            .join("\n");
        checked(
            args,
            Output {
                code: status.code(),
                stdout,
                stderr,
            },
        )
    }
}

fn checked<S: AsRef<OsStr>>(args: &[S], out: Output) -> Result<Vec<u8>> {
    if out.success() {
        return Ok(out.stdout);
    }
    let command = args
        .iter()
        .map(|a| a.as_ref().to_string_lossy())
        .find(|a| !a.starts_with('-'))
        .unwrap_or_default()
        .into_owned();
    let mut stderr = out.stderr;
    if stderr.trim().is_empty() {
        // Some commands (merge, cherry-pick) report conflicts on stdout.
        stderr = String::from_utf8_lossy(&out.stdout).into_owned();
    }
    Err(Error::Git {
        command,
        code: out.code,
        stderr,
    })
}

/// Splits NUL-terminated records, dropping the empty tail.
pub(crate) fn split_nul(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| *b == 0).filter(|part| !part.is_empty())
}

pub(crate) fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
