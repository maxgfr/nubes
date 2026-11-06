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
    /// `owner/name` (a folder linked to one repository).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub repo: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prefix: String,
    /// A folder spread over repositories `owner/name-1`, `owner/name-2`…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<PoolConfig>,
    pub device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PoolConfig {
    pub owner: String,
    pub name: String,
    /// A member takes no new file past this size, in bytes.
    pub max_size: u64,
}

/// Under which name a device keeps a pool's key (one key for all its repositories).
pub fn pool_key_id(owner: &str, name: &str) -> (String, String) {
    (format!("pool:{owner}/{name}"), String::new())
}

impl Config {
    /// Under which name this device keeps the folder's key.
    pub fn key_id(&self) -> (String, String) {
        match &self.pool {
            Some(p) => pool_key_id(&p.owner, &p.name),
            None => (self.repo.clone(), self.prefix.clone()),
        }
    }
}

/// A repository of a pool, as last seen.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemberState {
    pub repo: String,
    pub branch: String,
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
    /// The commit of the last successful sync (a folder linked to one repository).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// Repository → its commit as of the last successful sync.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub heads: BTreeMap<String, String>,
    /// A pool's repositories, in order (`name-1` first), checked to belong to it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<MemberState>,
    /// The base snapshot (both sides as of `head`).
    #[serde(default)]
    pub files: BTreeMap<String, FileState>,
}

impl State {
    /// The commit of `repo` as of the last sync.
    pub fn head_of(&self, repo: &str) -> Option<&str> {
        self.heads
            .get(repo)
            .map(String::as_str)
            .or(self.head.as_deref())
    }
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
            "{} is not inside a nubes folder: run `nubes init <name>` (or `nubes init <owner/repo>`) there first",
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

/// What `nubes init` links a folder to.
#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    /// `owner/name` or `owner/name:prefix`.
    Repo { repo: String, prefix: String },
    /// A bare name: the pool `<name>-1`, `<name>-2`… on the token's account.
    Pool { name: String },
}

fn valid_name(x: &str) -> bool {
    !x.is_empty()
        && x.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Parses a pool name, `owner/name` or `owner/name:prefix` (also a GitHub URL).
pub fn parse_target(s: &str) -> Result<Target> {
    let s = s
        .trim()
        .trim_start_matches("https://github.com/")
        .trim_start_matches("github.com/")
        .trim_end_matches('/')
        .trim_end_matches(".git");
    if !s.contains('/') && !s.contains(':') {
        // GitHub allows 100 characters, the member suffix needs a few.
        if !valid_name(s) || s.len() > 90 || s.starts_with('.') {
            bail!("expected a name (letters, digits, - _ .) or owner/repo[:folder], got {s:?}");
        }
        return Ok(Target::Pool {
            name: s.to_string(),
        });
    }
    let (repo, prefix) = match s.split_once(':') {
        Some((r, p)) => (r, p),
        None => (s, ""),
    };
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        bail!("expected owner/repo[:folder], got {s:?}");
    };
    if !valid_name(owner) || !valid_name(name) {
        bail!("expected owner/repo[:folder], got {s:?}");
    }
    let prefix = prefix.trim_matches('/').to_string();
    if !prefix.is_empty() && !nubes_core::is_safe_path(&prefix) {
        bail!("invalid folder {prefix:?}");
    }
    Ok(Target::Repo {
        repo: format!("{owner}/{name}"),
        prefix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(r: &str, p: &str) -> Target {
        Target::Repo {
            repo: r.into(),
            prefix: p.into(),
        }
    }

    #[test]
    fn targets() {
        assert_eq!(parse_target("me/files").unwrap(), repo("me/files", ""));
        assert_eq!(
            parse_target("https://github.com/me/files.git").unwrap(),
            repo("me/files", "")
        );
        assert_eq!(
            parse_target("me/files:cloud/docs/").unwrap(),
            repo("me/files", "cloud/docs")
        );
        assert_eq!(
            parse_target("files").unwrap(),
            Target::Pool {
                name: "files".into()
            }
        );
        assert!(parse_target("my files").is_err());
        assert!(parse_target("files:x").is_err());
        assert!(parse_target("me/files:../x").is_err());
    }

    #[test]
    fn old_files_still_read() {
        let c: Config =
            serde_json::from_str(r#"{"repo":"me/f","branch":"main","prefix":"","device":"mac"}"#)
                .unwrap();
        assert_eq!(c.repo, "me/f");
        assert!(c.pool.is_none());
        let s: State = serde_json::from_str(r#"{"head":"abc","files":{}}"#).unwrap();
        assert_eq!(s.head.as_deref(), Some("abc"));
        assert!(s.heads.is_empty());
    }
}
