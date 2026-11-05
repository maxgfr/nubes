//! Where the token comes from, in order:
//! 1. `NUBES_TOKEN`;
//! 2. what `nubes login` stored: the macOS Keychain, or elsewhere
//!    `~/.config/nubes/credentials` (mode 0600), or `NUBES_CREDENTIALS_FILE`;
//! 3. `gh auth token`, if the GitHub CLI is signed in.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};

const SERVICE: &str = "nubes";
const ACCOUNT: &str = "github.com";

pub enum Source {
    Env,
    Stored,
    GhCli,
}

impl Source {
    pub fn describe(&self) -> &'static str {
        match self {
            Source::Env => "NUBES_TOKEN",
            Source::Stored => store_name(),
            Source::GhCli => "gh auth token",
        }
    }
}

pub fn token() -> Result<(String, Source)> {
    if let Ok(t) = std::env::var("NUBES_TOKEN") {
        if !t.trim().is_empty() {
            return Ok((t.trim().to_string(), Source::Env));
        }
    }
    if let Some(t) = load()? {
        return Ok((t, Source::Stored));
    }
    if std::env::var_os("NUBES_NO_GH").is_none() {
        if let Ok(out) = Command::new("gh")
            .args(["auth", "token"])
            .stderr(Stdio::null())
            .output()
        {
            let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && !t.is_empty() {
                return Ok((t, Source::GhCli));
            }
        }
    }
    bail!("no GitHub token: run `nubes login` (or set NUBES_TOKEN)")
}

fn file_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("NUBES_CREDENTIALS_FILE") {
        return Some(PathBuf::from(p));
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("nubes").join("credentials"))
}

fn use_keychain() -> bool {
    cfg!(target_os = "macos") && std::env::var_os("NUBES_CREDENTIALS_FILE").is_none()
}

pub fn store_name() -> &'static str {
    if use_keychain() {
        "the macOS Keychain"
    } else {
        "~/.config/nubes/credentials"
    }
}

pub fn load() -> Result<Option<String>> {
    if use_keychain() {
        let out = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
            .stderr(Stdio::null())
            .output()
            .context("running /usr/bin/security")?;
        let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Ok((out.status.success() && !t.is_empty()).then_some(t));
    }
    let Some(p) = file_path() else {
        return Ok(None);
    };
    match fs::read_to_string(&p) {
        Ok(t) if !t.trim().is_empty() => Ok(Some(t.trim().to_string())),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", p.display())),
    }
}

pub fn store(token: &str) -> Result<()> {
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        bail!("that does not look like a GitHub token");
    }
    if use_keychain() {
        // Through `security -i` on stdin, so the token never shows in a process list.
        let mut child = Command::new("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .context("running /usr/bin/security")?;
        let mut stdin = child.stdin.take().context("security stdin")?;
        writeln!(
            stdin,
            "add-generic-password -U -s {SERVICE} -a {ACCOUNT} -l nubes -w {token}"
        )?;
        drop(stdin);
        if !child.wait()?.success() {
            bail!("could not store the token in the Keychain");
        }
        return Ok(());
    }
    let p = file_path().context("no HOME to store the token in")?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(&p)
        .with_context(|| format!("writing {}", p.display()))?;
    writeln!(f, "{token}")?;
    Ok(())
}

pub fn remove() -> Result<bool> {
    if use_keychain() {
        let st = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        return Ok(st.success());
    }
    match file_path() {
        Some(p) if p.exists() => {
            fs::remove_file(p)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}
