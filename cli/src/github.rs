//! A blocking GitHub REST client: the same endpoints, retries and quirks as
//! the web app's `src/github/client.ts`.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::thread::sleep;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::crypt::Cipher;

pub const API: &str = "https://api.github.com";
pub const META_PATH: &str = ".nubes/meta.json";
/// FORMAT.md version of an encrypted folder.
const AGE_FORMAT_VERSION: u32 = 2;
const BODY_LIMIT: u64 = 256 * 1024 * 1024;

/// A non-2xx answer from GitHub.
#[derive(Debug)]
pub struct StatusError {
    pub status: u16,
    pub message: String,
    pub path: String,
}

impl fmt::Display for StatusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let hint = match self.status {
            401 => " (the token is invalid or expired: run `nubes login`)",
            403 => " (the token lacks a permission: Contents read and write on this repository)",
            404 => " (no such repository, or the token cannot see it)",
            _ => "",
        };
        write!(
            f,
            "GitHub {} on {}: {}{hint}",
            self.status, self.path, self.message
        )
    }
}

impl std::error::Error for StatusError {}

/// The branch moved between reading it and updating it.
#[derive(Debug)]
pub struct RefMoved;

impl fmt::Display for RefMoved {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the branch moved while committing")
    }
}

impl std::error::Error for RefMoved {}

pub fn status_of(err: &anyhow::Error) -> Option<u16> {
    err.downcast_ref::<StatusError>().map(|e| e.status)
}

#[derive(Debug, Clone, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    pub mode: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sha: String,
    #[serde(default)]
    pub size: Option<u64>,
}

/// A change in a commit; `sha: None` deletes the path.
#[derive(Debug, Clone)]
pub struct Change {
    pub path: String,
    pub mode: String,
    pub sha: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Commit {
    pub sha: String,
    pub message: String,
    pub date: String,
    pub author: String,
}

/// The answer to a conditional read of the branch.
#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    NotModified,
    Changed {
        head: Option<String>,
        etag: Option<String>,
    },
}

pub struct GitHub {
    agent: ureq::Agent,
    api: String,
    token: String,
}

enum Body<'a> {
    None,
    Json(&'a Value),
}

impl GitHub {
    pub fn new(token: String, api: Option<String>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_global(Some(Duration::from_secs(600)))
            .user_agent(concat!("nubes-cli/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        let api = api.unwrap_or_else(|| API.to_string());
        Self {
            agent,
            api: api.trim_end_matches('/').to_string(),
            token,
        }
    }

    fn send(&self, method: &str, path: &str, body: Body<'_>, accept: &str) -> Result<Vec<u8>> {
        let url = format!("{}{}", self.api, path);
        let idempotent = method == "GET" || path.ends_with("/git/blobs");
        let auth = format!("Bearer {}", self.token);
        for attempt in 0u32.. {
            let result = match (method, &body) {
                ("GET", _) => self
                    .agent
                    .get(&url)
                    .header("accept", accept)
                    .header("authorization", &auth)
                    .header("x-github-api-version", "2022-11-28")
                    .call(),
                (m, b) => {
                    let req = match m {
                        "POST" => self.agent.post(&url),
                        "PATCH" => self.agent.patch(&url),
                        "PUT" => self.agent.put(&url),
                        other => return Err(anyhow!("unsupported method {other}")),
                    }
                    .header("accept", accept)
                    .header("authorization", &auth)
                    .header("x-github-api-version", "2022-11-28");
                    match b {
                        Body::Json(v) => req.send_json(v),
                        Body::None => req.send_empty(),
                    }
                }
            };
            let mut res = match result {
                Ok(r) => r,
                Err(e) if idempotent && attempt < 3 => {
                    eprintln!("network error ({e}), retrying");
                    sleep(Duration::from_secs(1 << attempt));
                    continue;
                }
                Err(e) => return Err(anyhow!(e).context(format!("{method} {path}"))),
            };
            let status = res.status().as_u16();
            if (200..300).contains(&status) {
                return res
                    .body_mut()
                    .with_config()
                    .limit(BODY_LIMIT)
                    .read_to_vec()
                    .with_context(|| format!("reading {path}"));
            }
            let header = |name: &str| -> Option<String> {
                res.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            };
            if let Some(wait) = retry_delay(
                status,
                attempt,
                idempotent,
                header("retry-after"),
                header("x-ratelimit-remaining"),
                header("x-ratelimit-reset"),
            ) {
                eprintln!("GitHub asked to slow down, waiting {}s", wait.as_secs());
                sleep(wait);
                continue;
            }
            let text = res
                .body_mut()
                .with_config()
                .limit(1024 * 1024)
                .read_to_string()
                .unwrap_or_default();
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["message"].as_str().map(str::to_string))
                .unwrap_or(text);
            return Err(StatusError {
                status,
                message,
                path: path.to_string(),
            }
            .into());
        }
        unreachable!()
    }

    fn json(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let body = body.map_or(Body::None, Body::Json);
        let bytes = self.send(method, path, body, "application/vnd.github+json")?;
        serde_json::from_slice(&bytes).with_context(|| format!("decoding {path}"))
    }

    pub fn user(&self) -> Result<String> {
        let v = self.json("GET", "/user", None)?;
        Ok(v["login"].as_str().unwrap_or_default().to_string())
    }

    /// `(default branch, can push)`.
    pub fn repo(&self, full: &str) -> Result<(String, bool)> {
        let v = self.json("GET", &format!("/repos/{full}"), None)?;
        Ok((
            v["default_branch"].as_str().unwrap_or("main").to_string(),
            v["permissions"]["push"].as_bool().unwrap_or(true),
        ))
    }

    /// Size of the repository in bytes, as GitHub reports it (updated a while
    /// after changes; every version counts).
    pub fn repo_size(&self, full: &str) -> Result<u64> {
        let v = self.json("GET", &format!("/repos/{full}"), None)?;
        Ok(v["size"].as_u64().unwrap_or(0) * 1024)
    }

    /// Whether the token can really write:`permissions.push` describes the
    /// account, not a fine-grained token. Creates an empty blob (harmless,
    /// never referenced), refused with 403 for a Contents: Read token. An
    /// empty repository refuses the git data API (409): nothing to check yet.
    pub fn can_write(&self, full: &str) -> Result<bool> {
        match self.create_blob(full, b"") {
            Ok(_) => Ok(true),
            Err(e) if status_of(&e) == Some(409) => Ok(true),
            Err(e) if matches!(status_of(&e), Some(403 | 404)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// The branch's commit, or None if it (or the whole repository) is empty.
    pub fn head(&self, full: &str, branch: &str) -> Result<Option<String>> {
        match self.json(
            "GET",
            &format!("/repos/{full}/git/ref/heads/{}", enc_ref(branch)),
            None,
        ) {
            Ok(v) => Ok(v["object"]["sha"].as_str().map(str::to_string)),
            Err(e) if matches!(status_of(&e), Some(404 | 409)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The branch's commit, asked with the ETag of the previous answer: an
    /// unchanged branch answers 304, which costs no rate limit. Falls back to
    /// a plain `head` for anything unexpected.
    pub fn head_if_changed(&self, full: &str, branch: &str, etag: Option<&str>) -> Result<Poll> {
        let url = format!(
            "{}/repos/{full}/git/ref/heads/{}",
            self.api,
            enc_ref(branch)
        );
        let mut req = self
            .agent
            .get(&url)
            .header("accept", "application/vnd.github+json")
            .header("authorization", &format!("Bearer {}", self.token))
            .header("x-github-api-version", "2022-11-28");
        if let Some(e) = etag {
            req = req.header("if-none-match", e);
        }
        let Ok(mut res) = req.call() else {
            return Ok(Poll::Changed {
                head: self.head(full, branch)?,
                etag: None,
            });
        };
        let status = res.status().as_u16();
        if status == 304 {
            return Ok(Poll::NotModified);
        }
        if status == 200 {
            let etag = res
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let v: Value = res.body_mut().read_json()?;
            return Ok(Poll::Changed {
                head: v["object"]["sha"].as_str().map(str::to_string),
                etag,
            });
        }
        Ok(Poll::Changed {
            head: self.head(full, branch)?,
            etag: None,
        })
    }

    pub fn commit_tree(&self, full: &str, commit: &str) -> Result<String> {
        let v = self.json("GET", &format!("/repos/{full}/git/commits/{commit}"), None)?;
        v["tree"]["sha"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("commit {commit} has no tree"))
    }

    pub fn tree(&self, full: &str, tree: &str) -> Result<Vec<TreeEntry>> {
        let v = self.json(
            "GET",
            &format!("/repos/{full}/git/trees/{tree}?recursive=1"),
            None,
        )?;
        if !v["truncated"].as_bool().unwrap_or(false) {
            return Ok(serde_json::from_value(v["tree"].clone())?);
        }
        let mut out = Vec::new();
        self.walk(full, tree, "", &mut out)?;
        Ok(out)
    }

    fn walk(&self, full: &str, tree: &str, prefix: &str, out: &mut Vec<TreeEntry>) -> Result<()> {
        let v = self.json("GET", &format!("/repos/{full}/git/trees/{tree}"), None)?;
        let entries: Vec<TreeEntry> = serde_json::from_value(v["tree"].clone())?;
        for mut e in entries {
            if !prefix.is_empty() {
                e.path = format!("{prefix}/{}", e.path);
            }
            let sub = (e.kind == "tree").then(|| (e.sha.clone(), e.path.clone()));
            out.push(e);
            if let Some((sha, path)) = sub {
                self.walk(full, &sha, &path, out)?;
            }
        }
        Ok(())
    }

    pub fn blob(&self, full: &str, sha: &str) -> Result<Vec<u8>> {
        self.send(
            "GET",
            &format!("/repos/{full}/git/blobs/{sha}"),
            Body::None,
            "application/vnd.github.raw+json",
        )
    }

    pub fn create_blob(&self, full: &str, data: &[u8]) -> Result<String> {
        let body = json!({
            "content": base64::engine::general_purpose::STANDARD.encode(data),
            "encoding": "base64",
        });
        let v = self.json("POST", &format!("/repos/{full}/git/blobs"), Some(&body))?;
        v["sha"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("no sha for the new blob"))
    }

    pub fn create_tree(&self, full: &str, base: &str, changes: &[Change]) -> Result<String> {
        let tree: Vec<Value> = changes
            .iter()
            .map(|c| json!({ "path": c.path, "mode": c.mode, "type": "blob", "sha": c.sha }))
            .collect();
        let body = json!({ "base_tree": base, "tree": tree });
        let v = self.json("POST", &format!("/repos/{full}/git/trees"), Some(&body))?;
        v["sha"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("no sha for the new tree"))
    }

    pub fn create_commit(
        &self,
        full: &str,
        message: &str,
        tree: &str,
        parent: &str,
    ) -> Result<String> {
        let body = json!({ "message": message, "tree": tree, "parents": [parent] });
        let v = self.json("POST", &format!("/repos/{full}/git/commits"), Some(&body))?;
        v["sha"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("no sha for the new commit"))
    }

    /// Fast-forward only; `RefMoved` if someone else moved the branch.
    pub fn update_ref(&self, full: &str, branch: &str, commit: &str) -> Result<()> {
        let body = json!({ "sha": commit, "force": false });
        match self.json(
            "PATCH",
            &format!("/repos/{full}/git/refs/heads/{}", enc_ref(branch)),
            Some(&body),
        ) {
            Ok(_) => Ok(()),
            Err(e) if matches!(status_of(&e), Some(409 | 422)) => Err(RefMoved.into()),
            Err(e) => Err(e),
        }
    }

    /// Creates one file through the contents API (works on an empty repository).
    pub fn put_file(
        &self,
        full: &str,
        branch: &str,
        path: &str,
        data: &[u8],
        message: &str,
    ) -> Result<()> {
        let body = json!({
            "message": message,
            "content": base64::engine::general_purpose::STANDARD.encode(data),
            "branch": branch,
        });
        self.json(
            "PUT",
            &format!("/repos/{full}/contents/{}", enc_path(path)),
            Some(&body),
        )?;
        Ok(())
    }

    /// The blob id of `path` at `rev`, or None.
    pub fn file_at(&self, full: &str, path: &str, rev: &str) -> Result<Option<String>> {
        match self.json(
            "GET",
            &format!("/repos/{full}/contents/{}?ref={}", enc_path(path), enc(rev)),
            None,
        ) {
            Ok(v) if v["type"] == "file" => Ok(v["sha"].as_str().map(str::to_string)),
            Ok(_) => Ok(None),
            Err(e) if status_of(&e) == Some(404) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn history(
        &self,
        full: &str,
        branch: &str,
        path: &str,
        limit: usize,
    ) -> Result<Vec<Commit>> {
        let mut q = format!("sha={}&per_page={}", enc(branch), limit.clamp(1, 100));
        if !path.is_empty() {
            q.push_str(&format!("&path={}", enc(path)));
        }
        let v = self.json("GET", &format!("/repos/{full}/commits?{q}"), None)?;
        let list = v.as_array().cloned().unwrap_or_default();
        Ok(list
            .iter()
            .map(|c| Commit {
                sha: c["sha"].as_str().unwrap_or_default().to_string(),
                message: c["commit"]["message"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                date: c["commit"]["author"]["date"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                author: c["author"]["login"]
                    .as_str()
                    .or_else(|| c["commit"]["author"]["name"].as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
            .collect())
    }
}

fn retry_delay(
    status: u16,
    attempt: u32,
    idempotent: bool,
    retry_after: Option<String>,
    remaining: Option<String>,
    reset: Option<String>,
) -> Option<Duration> {
    if attempt >= 3 {
        return None;
    }
    let after: u64 = retry_after.and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    if (status == 403 || status == 429) && after > 0 {
        return (after <= 60).then(|| Duration::from_secs(after));
    }
    if status == 403 && remaining.as_deref() == Some("0") {
        let reset: u64 = reset.and_then(|s| s.parse().ok())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        let wait = reset.saturating_sub(now);
        return (wait <= 60).then(|| Duration::from_secs(wait + 1));
    }
    if status == 429 {
        return Some(Duration::from_secs(2 << attempt));
    }
    if idempotent && status >= 500 {
        return Some(Duration::from_secs(1 << attempt));
    }
    None
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn enc_path(p: &str) -> String {
    p.split('/').map(enc).collect::<Vec<_>>().join("/")
}

fn enc_ref(r: &str) -> String {
    enc_path(r)
}

#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub sha: String,
    pub size: u64,
    pub mode: String,
}

/// nubes' own files, at the top of the nubes folder (the prefix).
pub const OWN_DIR: &str = ".nubes/";
/// An encrypted folder's key, encrypted with its passphrase. Its presence makes the folder encrypted.
pub const KEY_FILE: &str = ".nubes/key.age";
/// What each `<path>.age` holds: `{ plainSha, size, blobSha }`.
pub const MANIFEST_FILE: &str = ".nubes/manifest.json";
const FOLDER_META: &str = ".nubes/meta.json";

/// One file of an encrypted folder, as the manifest records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sealed {
    /// The git blob id of the plain content (what the engine compares).
    pub plain_sha: String,
    pub size: u64,
    /// The blob that stores it, encrypted, as `<path>.age`.
    pub blob_sha: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub files: BTreeMap<String, Sealed>,
}

/// The branch as seen by nubes: files under the prefix, relative to it.
/// In an encrypted folder, paths lose their `.age` and ids are those of the
/// plain content, so the engine sees the same thing in both modes.
#[derive(Debug, Default)]
pub struct RemoteState {
    pub head: Option<String>,
    pub tree: Option<String>,
    pub files: BTreeMap<String, RemoteFile>,
    /// Content already stored: never uploaded again.
    pub blobs: HashSet<String>,
    pub has_meta: bool,
    /// Whether the folder is encrypted (it has `.nubes/key.age`).
    pub encrypted: bool,
    pub key_blob: Option<String>,
    pub manifest: Manifest,
    /// Encrypted folder: plain blob id → stored blob id.
    pub stored: HashMap<String, String>,
    /// Encrypted folder: files nubes did not write (no manifest entry): left alone.
    pub foreign: Vec<String>,
}

pub struct Remote<'a> {
    pub gh: &'a GitHub,
    pub full: String,
    pub branch: String,
    pub prefix: String,
    cipher: RefCell<Option<Cipher>>,
    encrypted: Cell<bool>,
    /// Plain id → (stored id, size), for content seen or uploaded in this run.
    known: RefCell<HashMap<String, (String, u64)>>,
    manifests: RefCell<HashMap<String, Manifest>>,
}

impl<'a> Remote<'a> {
    pub fn new(gh: &'a GitHub, full: &str, branch: &str, prefix: &str) -> Self {
        let prefix = prefix
            .split('/')
            .filter(|p| !p.is_empty() && *p != ".")
            .collect::<Vec<_>>()
            .join("/");
        Self {
            gh,
            full: full.to_string(),
            branch: branch.to_string(),
            prefix,
            cipher: RefCell::new(None),
            encrypted: Cell::new(false),
            known: RefCell::new(HashMap::new()),
            manifests: RefCell::new(HashMap::new()),
        }
    }

    pub fn repo_path(&self, path: &str) -> String {
        if self.prefix.is_empty() {
            path.to_string()
        } else {
            format!("{}/{path}", self.prefix)
        }
    }

    /// Where a file is stored in the repository (`.age` added in an encrypted folder).
    pub fn stored_path(&self, path: &str) -> String {
        if self.encrypted.get() {
            format!("{}.age", self.repo_path(path))
        } else {
            self.repo_path(path)
        }
    }

    fn manifest(&self, sha: &str) -> Result<Manifest> {
        if let Some(m) = self.manifests.borrow().get(sha) {
            return Ok(m.clone());
        }
        let m: Manifest =
            serde_json::from_slice(&self.gh.blob(&self.full, sha)?).context("invalid manifest")?;
        self.manifests
            .borrow_mut()
            .insert(sha.to_string(), m.clone());
        Ok(m)
    }

    pub fn state(&self) -> Result<RemoteState> {
        let mut s = RemoteState {
            head: self.gh.head(&self.full, &self.branch)?,
            ..Default::default()
        };
        let Some(head) = s.head.clone() else {
            return Ok(s);
        };
        let tree = self.gh.commit_tree(&self.full, &head)?;
        let strip = if self.prefix.is_empty() {
            String::new()
        } else {
            format!("{}/", self.prefix)
        };
        let entries: Vec<TreeEntry> = self
            .gh
            .tree(&self.full, &tree)?
            .into_iter()
            .filter(|e| e.kind == "blob")
            .collect();
        let find = |p: &str| {
            let p = format!("{strip}{p}");
            entries.iter().find(|e| e.path == p).map(|e| e.sha.clone())
        };
        s.key_blob = find(KEY_FILE);
        s.encrypted = s.key_blob.is_some();
        if s.encrypted {
            if let Some(m) = find(MANIFEST_FILE) {
                s.manifest = self.manifest(&m)?;
            }
        }
        for e in entries {
            if e.path == META_PATH {
                s.has_meta = true;
            }
            if !s.encrypted {
                s.blobs.insert(e.sha.clone());
            }
            // Symlinks are not synced, nor is nubes' own metadata.
            if e.mode == "120000" || !e.path.starts_with(&strip) {
                continue;
            }
            let rel = &e.path[strip.len()..];
            if rel.starts_with(OWN_DIR) {
                continue;
            }
            if !s.encrypted {
                s.files.insert(
                    rel.to_string(),
                    RemoteFile {
                        sha: e.sha,
                        size: e.size.unwrap_or(0),
                        mode: e.mode,
                    },
                );
                continue;
            }
            let sealed = rel
                .strip_suffix(".age")
                .and_then(|p| s.manifest.files.get(p).map(|m| (p, m)))
                .filter(|(_, m)| m.blob_sha == e.sha);
            let Some((path, m)) = sealed else {
                s.foreign.push(rel.to_string());
                continue;
            };
            s.blobs.insert(m.plain_sha.clone());
            s.stored.insert(m.plain_sha.clone(), e.sha.clone());
            self.known
                .borrow_mut()
                .insert(m.plain_sha.clone(), (e.sha.clone(), m.size));
            s.files.insert(
                path.to_string(),
                RemoteFile {
                    sha: m.plain_sha.clone(),
                    size: m.size,
                    mode: e.mode,
                },
            );
        }
        self.encrypted.set(s.encrypted);
        s.tree = Some(tree);
        Ok(s)
    }

    /// Writes `.nubes/meta.json` unless present (creating the first commit of an empty repository).
    pub fn ensure_meta(&self, state: &RemoteState) -> Result<bool> {
        if state.has_meta {
            return Ok(false);
        }
        let meta = json!({
            "format": "nubes",
            "version": nubes_core::FORMAT_VERSION,
            "mode": "plain",
            "createdAt": crate::util::now_rfc3339(),
        });
        let text = format!("{}\n", serde_json::to_string_pretty(&meta)?);
        self.gh.put_file(
            &self.full,
            &self.branch,
            META_PATH,
            text.as_bytes(),
            "nubes: initialize",
        )?;
        Ok(true)
    }

    pub fn set_cipher(&self, c: Cipher) {
        *self.cipher.borrow_mut() = Some(c);
    }

    /// Makes sure an encrypted folder can be read and written: the key this
    /// device keeps, or the passphrase (then the key is kept for next time).
    pub fn unlock(&self, state: &RemoteState) -> Result<()> {
        if !state.encrypted || self.cipher.borrow().is_some() {
            return Ok(());
        }
        if let Some(secret) = crate::creds::load_key(&self.full, &self.prefix)? {
            self.set_cipher(Cipher::parse(&secret)?);
            return Ok(());
        }
        let key_blob = state.key_blob.as_deref().context("no key in this folder")?;
        let key_file = self.gh.blob(&self.full, key_blob)?;
        let pass = crate::crypt::passphrase("Passphrase of this encrypted folder: ", false)?;
        let c = Cipher::unlock(&key_file, &pass)?;
        crate::creds::store_key(&self.full, &self.prefix, &c.secret())?;
        self.set_cipher(c);
        Ok(())
    }

    /// Makes a new, empty folder encrypted: its key, locked with `passphrase`.
    pub fn init_encryption(&self, passphrase: &str) -> Result<Cipher> {
        let mut state = self.state()?;
        if self.ensure_meta(&state)? {
            state = self.state()?;
        }
        if state.encrypted {
            bail!("this folder is already encrypted");
        }
        if !state.files.is_empty() {
            bail!(
                "this folder already has {} plain file(s): encryption is for a new folder (a new repository, or repo:new-folder)",
                state.files.len()
            );
        }
        let c = Cipher::generate();
        let meta = json!({
            "format": "nubes",
            "version": AGE_FORMAT_VERSION,
            "mode": "age",
            "recipient": c.recipient(),
            "createdAt": crate::util::now_rfc3339(),
        });
        let meta = format!("{}\n", serde_json::to_string_pretty(&meta)?);
        let changes = [
            Change {
                path: KEY_FILE.into(),
                mode: "100644".into(),
                sha: Some(self.gh.create_blob(&self.full, &c.lock(passphrase)?)?),
            },
            Change {
                path: FOLDER_META.into(),
                mode: "100644".into(),
                sha: Some(self.gh.create_blob(&self.full, meta.as_bytes())?),
            },
        ];
        self.commit(&changes, "nubes: encrypt this folder", &state)?;
        crate::creds::store_key(&self.full, &self.prefix, &c.secret())?;
        Ok(c)
    }

    /// Whether `sha` (plain) is already stored.
    pub fn has(&self, sha: &str, state: &RemoteState) -> bool {
        if state.encrypted {
            state.stored.contains_key(sha) || self.known.borrow().contains_key(sha)
        } else {
            state.blobs.contains(sha)
        }
    }

    /// Stores content whose plain id is `sha` (encrypted in an encrypted folder).
    pub fn put(&self, data: &[u8], sha: &str, state: &RemoteState) -> Result<()> {
        if self.has(sha, state) {
            return Ok(());
        }
        if !state.encrypted {
            let got = self.gh.create_blob(&self.full, data)?;
            if got != sha {
                bail!("GitHub stored {got}, expected {sha}");
            }
            return Ok(());
        }
        let sealed = self.with_cipher(|c| c.encrypt(data))?;
        let blob = self.gh.create_blob(&self.full, &sealed)?;
        self.known
            .borrow_mut()
            .insert(sha.to_string(), (blob, data.len() as u64));
        Ok(())
    }

    /// The plain content whose id is `sha`.
    pub fn get(&self, sha: &str) -> Result<Vec<u8>> {
        if !self.encrypted.get() {
            return self.gh.blob(&self.full, sha);
        }
        let stored = self
            .known
            .borrow()
            .get(sha)
            .map(|(b, _)| b.clone())
            .with_context(|| format!("no encrypted content for {sha}"))?;
        let data = self.gh.blob(&self.full, &stored)?;
        self.with_cipher(|c| c.decrypt(&data))
    }

    fn with_cipher<T>(&self, f: impl FnOnce(&Cipher) -> Result<T>) -> Result<T> {
        match self.cipher.borrow().as_ref() {
            Some(c) => f(c),
            None => bail!("this folder is encrypted and locked: run `nubes unlock`"),
        }
    }

    /// The plain id of `path` at commit `rev`, if it existed there.
    pub fn version_at(&self, path: &str, rev: &str) -> Result<Option<String>> {
        if !self.encrypted.get() {
            return self.gh.file_at(&self.full, &self.repo_path(path), rev);
        }
        let Some(m) = self
            .gh
            .file_at(&self.full, &self.repo_path(MANIFEST_FILE), rev)?
        else {
            return Ok(None);
        };
        let Some(e) = self.manifest(&m)?.files.get(path).cloned() else {
            return Ok(None);
        };
        self.known
            .borrow_mut()
            .insert(e.plain_sha.clone(), (e.blob_sha, e.size));
        Ok(Some(e.plain_sha))
    }

    /// Commits `changes` (nubes paths, plain ids) on `state`; `RefMoved` if the branch moved.
    /// In an encrypted folder, files go to `<path>.age` and the manifest follows in the same commit.
    pub fn commit(&self, changes: &[Change], message: &str, state: &RemoteState) -> Result<String> {
        let head = state.head.as_deref().context("empty repository")?;
        let tree = state.tree.as_deref().context("empty repository")?;
        let mut out: Vec<Change> = Vec::new();
        if state.encrypted {
            let mut manifest = state.manifest.clone();
            manifest.version = 1;
            for c in changes {
                let path = format!("{}.age", self.repo_path(&c.path));
                match &c.sha {
                    None => {
                        manifest.files.remove(&c.path);
                        out.push(Change { path, ..c.clone() });
                    }
                    Some(plain) => {
                        let (blob, size) = self
                            .known
                            .borrow()
                            .get(plain)
                            .cloned()
                            .with_context(|| format!("{} was not uploaded", c.path))?;
                        manifest.files.insert(
                            c.path.clone(),
                            Sealed {
                                plain_sha: plain.clone(),
                                size,
                                blob_sha: blob.clone(),
                            },
                        );
                        out.push(Change {
                            path,
                            mode: c.mode.clone(),
                            sha: Some(blob),
                        });
                    }
                }
            }
            let text = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
            out.push(Change {
                path: self.repo_path(MANIFEST_FILE),
                mode: "100644".into(),
                sha: Some(self.gh.create_blob(&self.full, text.as_bytes())?),
            });
        } else {
            out = changes
                .iter()
                .map(|c| Change {
                    path: self.repo_path(&c.path),
                    ..c.clone()
                })
                .collect();
        }
        let new_tree = self.gh.create_tree(&self.full, tree, &out)?;
        if new_tree == tree {
            return Ok(head.to_string());
        }
        let commit = self
            .gh
            .create_commit(&self.full, message, &new_tree, head)?;
        self.gh.update_ref(&self.full, &self.branch, &commit)?;
        Ok(commit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding() {
        assert_eq!(enc_path("a b/c+d.txt"), "a%20b/c%2Bd.txt");
        assert_eq!(enc("é"), "%C3%A9");
    }

    #[test]
    fn retries() {
        assert_eq!(
            retry_delay(403, 0, false, Some("3".into()), None, None),
            Some(Duration::from_secs(3))
        );
        assert_eq!(
            retry_delay(403, 0, false, Some("600".into()), None, None),
            None
        );
        assert_eq!(
            retry_delay(500, 0, true, None, None, None),
            Some(Duration::from_secs(1))
        );
        assert_eq!(retry_delay(500, 0, false, None, None, None), None);
        assert_eq!(retry_delay(422, 0, true, None, None, None), None);
        assert_eq!(retry_delay(429, 3, true, None, None, None), None);
    }
}
