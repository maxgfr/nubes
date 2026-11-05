//! Where the token comes from, in order:
//! 1. `NUBES_TOKEN`;
//! 2. what `nubes login` stored: the macOS Keychain, or elsewhere
//!    `~/.config/nubes/credentials` (mode 0600), or `NUBES_CREDENTIALS_FILE`;
//! 3. `gh auth token`, if the GitHub CLI is signed in.
//!
//! The keys of encrypted folders are kept the same way (one Keychain entry,
//! or one 0600 file beside the credentials, per folder).

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
    match file_path() {
        Some(p) => load_secret(ACCOUNT, &p),
        None => Ok(None),
    }
}

pub fn store(token: &str) -> Result<()> {
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        bail!("that does not look like a GitHub token");
    }
    let p = file_path().context("no HOME to store the token in")?;
    store_secret(ACCOUNT, &p, token, "nubes")
}

pub fn remove() -> Result<bool> {
    match file_path() {
        Some(p) => remove_secret(ACCOUNT, &p),
        None => Ok(false),
    }
}

/// Where an encrypted folder's key is kept: one entry per repository and folder.
fn key_account(repo: &str, prefix: &str) -> String {
    let id = nubes_core::git_blob_sha(format!("{repo}:{prefix}").as_bytes());
    format!("key-{}", &id[..16])
}

fn key_file(account: &str) -> Option<PathBuf> {
    let creds = file_path()?;
    Some(creds.with_file_name(format!(
        "{}.{account}",
        creds.file_name()?.to_string_lossy()
    )))
}

/// The key this device keeps for an encrypted folder.
pub fn load_key(repo: &str, prefix: &str) -> Result<Option<String>> {
    let account = key_account(repo, prefix);
    match key_file(&account) {
        Some(p) => load_secret(&account, &p),
        None => Ok(None),
    }
}

pub fn store_key(repo: &str, prefix: &str, secret: &str) -> Result<()> {
    if !secret
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        bail!("that does not look like an age key");
    }
    let account = key_account(repo, prefix);
    let p = key_file(&account).context("no HOME to store the key in")?;
    store_secret(&account, &p, secret, &format!("nubes key for {repo}"))
}

pub fn remove_key(repo: &str, prefix: &str) -> Result<bool> {
    let account = key_account(repo, prefix);
    match key_file(&account) {
        Some(p) => remove_secret(&account, &p),
        None => Ok(false),
    }
}

fn load_secret(account: &str, file: &PathBuf) -> Result<Option<String>> {
    if use_keychain() {
        let out = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
            .stderr(Stdio::null())
            .output()
            .context("running /usr/bin/security")?;
        let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Ok((out.status.success() && !t.is_empty()).then_some(t));
    }
    match fs::read_to_string(file) {
        Ok(t) if !t.trim().is_empty() => Ok(Some(t.trim().to_string())),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", file.display())),
    }
}

/// `secret` and `account` must be shell-safe words (checked by the callers).
fn store_secret(account: &str, file: &PathBuf, secret: &str, label: &str) -> Result<()> {
    if use_keychain() {
        // Through `security -i` on stdin, so the secret never shows in a process list.
        let mut child = Command::new("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .context("running /usr/bin/security")?;
        let mut stdin = child.stdin.take().context("security stdin")?;
        let label = label.replace('"', "");
        writeln!(
            stdin,
            "add-generic-password -U -s {SERVICE} -a {account} -l \"{label}\" -w {secret}"
        )?;
        drop(stdin);
        if !child.wait()?.success() {
            bail!("could not store it in the Keychain");
        }
        return Ok(());
    }
    if let Some(dir) = file.parent() {
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
        .open(file)
        .with_context(|| format!("writing {}", file.display()))?;
    writeln!(f, "{secret}")?;
    Ok(())
}

fn remove_secret(account: &str, file: &PathBuf) -> Result<bool> {
    if use_keychain() {
        let st = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", account])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        return Ok(st.success());
    }
    if file.exists() {
        fs::remove_file(file)?;
        Ok(true)
    } else {
        Ok(false)
    }
}
