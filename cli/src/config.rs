//! A synced folder: `.nubes/config.json` (what it is linked to) and
//! `.nubes/state.json` (the last synced state, and a hash cache).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const DIR: &str = ".nubes";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// `owner/name`.
    pub repo: String,
    pub branch: String,
    #[serde(default)]
    pub prefix: String,
    pub device: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileState {
    pub sha: String,
    pub size: u64,
    /// Modification time (ns since the epoch) when `sha` was known to match
    /// the local file; 0 when it was not (forces a re-hash).
    #[serde(default)]
    pub mtime: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    /// The commit of the last successful sync.
    pub head: Option<String>,
    /// The base snapshot (both sides as of `head`).
    #[serde(default)]
    pub files: BTreeMap<String, FileState>,
}

pub struct Folder {
    pub root: PathBuf,
    pub config: Config,
}

impl Folder {
    /// Finds the synced folder containing `start` (itself or a parent).
    pub fn find(start: &Path) -> Result<Self> {
        let start = start
            .canonicalize()
            .with_context(|| format!("no such folder: {}", start.display()))?;
        let mut dir = Some(start.as_path());
        while let Some(d) = dir {
            let cfg = d.join(DIR).join("config.json");
            if cfg.is_file() {
                let text = fs::read_to_string(&cfg)?;
                let config: Config = serde_json::from_str(&text)
                    .with_context(|| format!("invalid {}", cfg.display()))?;
                return Ok(Self {
                    root: d.to_path_buf(),
                    config,
                });
            }
            dir = d.parent();
        }
        bail!(
            "{} is not inside a nubes folder: run `nubes init <owner/repo>` there first",
            start.display()
        )
    }

    pub fn create(root: &Path, config: Config) -> Result<Self> {
        let dir = root.join(DIR);
        if dir.join("config.json").exists() {
            bail!(
                "{} is already linked (see {})",
                root.display(),
                dir.join("config.json").display()
            );
        }
        fs::create_dir_all(&dir)?;
        let f = Self {
            root: root.canonicalize()?,
            config,
        };
        write_json(&dir.join("config.json"), &f.config)?;
        f.save_state(&State::default())?;
        // Keeps the state folder out of git if the synced folder is itself a repository.
        fs::write(dir.join(".gitignore"), "*\n")?;
        Ok(f)
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join(DIR).join("state.json")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.root.join(DIR).join("tmp")
    }

    pub fn load_state(&self) -> Result<State> {
        match fs::read_to_string(self.state_path()) {
            Ok(t) => serde_json::from_str(&t).context("invalid .nubes/state.json"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save_state(&self, s: &State) -> Result<()> {
        write_json(&self.state_path(), s)
    }

    /// Lines of the folder's `.nubesignore`, if any.
    pub fn ignore_lines(&self) -> Result<Vec<String>> {
        match fs::read_to_string(self.root.join(".nubesignore")) {
            Ok(t) => Ok(t.lines().map(str::to_string).collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Writes through a temporary file and a rename, so a crash never leaves half a JSON file.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Parses `owner/name` or `owner/name:prefix`, also accepting a GitHub URL.
pub fn parse_target(s: &str) -> Result<(String, String)> {
    let s = s
        .trim()
        .trim_start_matches("https://github.com/")
        .trim_start_matches("github.com/")
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let (repo, prefix) = match s.split_once(':') {
        Some((r, p)) => (r, p),
        None => (s, ""),
    };
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        bail!("expected owner/repo[:folder], got {s:?}");
    };
    let ok = |x: &str| {
        !x.is_empty()
            && x.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    if !ok(owner) || !ok(name) {
        bail!("expected owner/repo[:folder], got {s:?}");
    }
    let prefix = prefix.trim_matches('/').to_string();
    if !prefix.is_empty() && !nubes_core::is_safe_path(&prefix) {
        bail!("invalid folder {prefix:?}");
    }
    Ok((format!("{owner}/{name}"), prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert_eq!(
            parse_target("me/files").unwrap(),
            ("me/files".into(), "".into())
        );
        assert_eq!(
            parse_target("https://github.com/me/files.git").unwrap(),
            ("me/files".into(), "".into())
        );
        assert_eq!(
            parse_target("me/files:cloud/docs/").unwrap(),
            ("me/files".into(), "cloud/docs".into())
        );
        assert!(parse_target("files").is_err());
        assert!(parse_target("me/files:../x").is_err());
    }
}
