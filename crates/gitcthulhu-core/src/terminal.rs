//! The embedded terminal: the user's shell in a pseudo-terminal (ConPTY on
//! Windows), started in the repository. Adapted from Hostly's local
//! terminals.

use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize, native_pty_system};

use crate::error::{Error, Result};

/// How long a program's last output may take after it exits. It only runs
/// out when a background job it started still holds the terminal.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

/// The user's shell in `cwd`, as a login shell on Unix so it reads the
/// profile files that set up PATH (apps started from the Dock get a minimal
/// one), with a UTF-8 locale when none is set. On Windows, PowerShell.
pub fn default_shell(cwd: &Path) -> ShellCommand {
    let mut env = vec![
        ("TERM".to_owned(), "xterm-256color".to_owned()),
        ("COLORTERM".to_owned(), "truecolor".to_owned()),
    ];
    let has_locale = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|n| std::env::var(n).is_ok_and(|v| !v.is_empty()));
    if cfg!(not(windows)) && !has_locale {
        env.push(("LANG".to_owned(), "en_US.UTF-8".to_owned()));
    }
    #[cfg(not(windows))]
    let (program, args) = {
        let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty());
        (
            shell.map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from),
            vec!["-l".to_owned()],
        )
    };
    #[cfg(windows)]
    let (program, args) = {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        (
            Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            vec!["-NoLogo".to_owned()],
        )
    };
    ShellCommand {
        program,
        args,
        env,
        cwd: cwd.to_owned(),
    }
}

/// A running terminal. Dropping it ends the program.
pub struct Terminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    input: Sender<Vec<u8>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl Terminal {
    /// Starts `command` in a `cols` × `rows` terminal. Output arrives through
    /// `on_output`, then `on_exit` once with the exit code (`None` when a
    /// signal ended it). The terminal I/O runs on threads of its own.
    pub fn spawn(
        command: ShellCommand,
        cols: u16,
        rows: u16,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    ) -> Result<Terminal> {
        let PtyPair { master, slave } = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(pty_error)?;
        let reader = master.try_clone_reader().map_err(pty_error)?;
        let mut builder = CommandBuilder::new(&command.program);
        builder.args(&command.args);
        for (name, value) in &command.env {
            builder.env(name, value);
        }
        builder.cwd(&command.cwd);
        let mut child = slave.spawn_command(builder).map_err(pty_error)?;
        // Only the program may keep this end open, or its exit would go unnoticed.
        drop(slave);
        // Taken only once the program runs: dropping the writer types an end
        // of input, and on macOS that makes tearing down a failed terminal hang.
        let mut writer = match master.take_writer() {
            Ok(writer) => writer,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(pty_error(e));
            }
        };
        let killer = child.clone_killer();

        let (output_done, output_ended) = mpsc::channel::<()>();
        thread::spawn(move || {
            read_output(reader, &on_output);
            drop(output_done);
        });
        // Input has a thread of its own, so a program that stops reading
        // can't hold anything up.
        let (input, queue) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            for bytes in queue {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        let on_exit = Arc::new(Mutex::new(Some(on_exit)));
        thread::spawn(move || {
            let status = child.wait().ok();
            // Let the last output through before reporting the exit.
            let _ = output_ended.recv_timeout(DRAIN_TIMEOUT);
            let code = status
                .filter(|s| s.signal().is_none())
                .map(|s| s.exit_code());
            if let Some(on_exit) = on_exit.lock().ok().and_then(|mut f| f.take()) {
                on_exit(code);
            }
        });
        Ok(Terminal {
            master: Mutex::new(master),
            input,
            killer: Mutex::new(killer),
        })
    }

    pub fn write(&self, bytes: Vec<u8>) {
        let _ = self.input.send(bytes);
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let master = self.master.lock().unwrap_or_else(|p| p.into_inner());
        master.resize(size(cols, rows)).map_err(pty_error)
    }

    /// Ends the program, as closing a terminal window does.
    pub fn close(&self) {
        let mut killer = self.killer.lock().unwrap_or_else(|p| p.into_inner());
        let _ = killer.kill();
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_output(mut reader: Box<dyn Read + Send>, on_output: &impl Fn(Vec<u8>)) {
    let mut buffer = vec![0; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => on_output(buffer[..n].to_vec()),
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        ..PtySize::default()
    }
}

fn pty_error(e: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("couldn't start the terminal: {e}"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn runs_a_program_and_reports_its_exit() {
        let dir = tempfile::tempdir().unwrap();
        let command = ShellCommand {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), r#"printf 'in %s\n' "$(basename "$PWD")"; read line; printf 'got %s\n' "$line"; exit 3"#.into()],
            env: Vec::new(),
            cwd: dir.path().to_owned(),
        };
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = mpsc::channel();
        let terminal = Terminal::spawn(
            command,
            80,
            24,
            move |bytes| {
                let _ = out_tx.send(bytes);
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .unwrap();
        terminal.resize(100, 30).unwrap();
        terminal.write(b"tentacles\r".to_vec());
        let code = exit_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let output: Vec<u8> = out_rx.try_iter().flatten().collect();
        let output = String::from_utf8_lossy(&output);
        let folder = dir.path().canonicalize().unwrap();
        let name = folder.file_name().unwrap().to_string_lossy();
        assert!(output.contains(&format!("in {name}")), "{output}");
        assert!(output.contains("got tentacles"), "{output}");
        assert_eq!(code, Some(3));
    }

    #[test]
    fn closing_ends_the_program() {
        let command = ShellCommand {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env: Vec::new(),
            cwd: std::env::temp_dir(),
        };
        let (exit_tx, exit_rx) = mpsc::channel();
        let terminal = Terminal::spawn(
            command,
            80,
            24,
            |_| {},
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .unwrap();
        terminal.close();
        assert_eq!(
            exit_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            None,
            "a signal ended it"
        );
    }
}
