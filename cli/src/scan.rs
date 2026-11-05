//! Reads the local folder into a snapshot (path → git blob id), re-hashing
//! only files whose size or modification time changed since the last sync.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use nubes_core::{BlobHasher, Matcher};
use walkdir::WalkDir;

use crate::config::FileState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFile {
    pub sha: String,
    pub size: u64,
    pub mtime: u64,
    pub executable: bool,
}

pub fn mtime_ns(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn is_exec(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_exec(_: &fs::Metadata) -> bool {
    false
}

/// Git blob id of a file, read in 1 MiB chunks.
pub fn hash_file(path: &Path, len: u64) -> Result<String> {
    let mut f = File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut h = BlobHasher::new(len);
    let mut buf = vec![0u8; 1 << 20];
    let mut seen = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        seen += n as u64;
        h.update(&buf[..n]);
    }
    h.try_finish().with_context(|| {
        format!(
            "{} changed while being read ({len} then {seen} bytes)",
            path.display()
        )
    })
}

pub struct Scan {
    pub files: BTreeMap<String, LocalFile>,
    /// Paths left out because they are not valid UTF-8 or not safe nubes paths.
    pub skipped: Vec<String>,
}

pub fn scan(root: &Path, cache: &BTreeMap<String, FileState>, matcher: &Matcher) -> Result<Scan> {
    let mut files = BTreeMap::new();
    let mut skipped = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter();
    let walker = walker.filter_entry(|e| {
        let Ok(rel) = e.path().strip_prefix(root) else {
            return true;
        };
        let Some(rel) = rel.to_str() else { return true };
        rel.is_empty()
            || !e.file_type().is_dir()
            || !matcher.is_dir_ignored(&rel.replace('\\', "/"))
    });
    for entry in walker {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(root)?;
        let Some(rel) = rel.to_str().map(|s| s.replace('\\', "/")) else {
            skipped.push(rel.to_string_lossy().into_owned());
            continue;
        };
        if matcher.is_ignored(&rel) {
            continue;
        }
        if !nubes_core::is_safe_path(&rel) {
            skipped.push(rel);
            continue;
        }
        let meta = entry.metadata()?;
        let (size, mtime) = (meta.len(), mtime_ns(&meta));
        let sha = match cache.get(&rel) {
            Some(c) if c.mtime != 0 && c.mtime == mtime && c.size == size => c.sha.clone(),
            _ => hash_file(entry.path(), size)?,
        };
        files.insert(
            rel,
            LocalFile {
                sha,
                size,
                mtime,
                executable: is_exec(&meta),
            },
        );
    }
    Ok(Scan { files, skipped })
}
