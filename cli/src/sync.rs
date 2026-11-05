//! Runs a sync: plan with nubes-core, apply the remote side in one commit,
//! then the local side, then store the new base.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use nubes_core::{plan, Action, Direction, Entry, Matcher, Plan, PlanInput, SkipReason, Snapshot};

use crate::config::{FileState, Folder, State};
use crate::github::{Change, Poll, RefMoved, Remote, RemoteState};
use crate::scan::{hash_file, mtime_ns, scan, LocalFile};
use crate::util;

pub struct Options {
    pub direction: Direction,
    pub dry_run: bool,
    pub quiet: bool,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub plan: Plan,
    pub commit: Option<String>,
}

pub fn base_snapshot(state: &State) -> Snapshot {
    state
        .files
        .iter()
        .map(|(p, f)| {
            (
                p.clone(),
                Entry {
                    sha: f.sha.clone(),
                    size: f.size,
                },
            )
        })
        .collect()
}

fn local_snapshot(files: &BTreeMap<String, LocalFile>) -> Snapshot {
    files
        .iter()
        .map(|(p, f)| {
            (
                p.clone(),
                Entry {
                    sha: f.sha.clone(),
                    size: f.size,
                },
            )
        })
        .collect()
}

fn remote_snapshot(r: &RemoteState) -> Snapshot {
    r.files
        .iter()
        .map(|(p, f)| {
            (
                p.clone(),
                Entry {
                    sha: f.sha.clone(),
                    size: f.size,
                },
            )
        })
        .collect()
}

/// One line per action, for `status` and `sync`.
pub fn describe(a: &Action) -> String {
    match a {
        Action::Upload { path, size, .. } => format!("↑ {path} ({})", util::human_size(*size)),
        Action::Download { path, size, .. } => format!("↓ {path} ({})", util::human_size(*size)),
        Action::DeleteLocal { path } => format!("✗ {path} (deleted remotely)"),
        Action::DeleteRemote { path } => format!("✗ {path} (deleted locally)"),
        Action::Conflict {
            path,
            renamed_to,
            upload,
            ..
        } => format!(
            "! {path}: changed on both sides, your copy kept as {renamed_to}{}",
            if *upload { "" } else { " (local only)" }
        ),
        Action::Skip { path, reason } => match reason {
            SkipReason::TooLarge => {
                format!("- {path}: skipped, too large for GitHub (100 MB per file)")
            }
            SkipReason::UnsafePath => format!("- {path}: skipped, not a valid path"),
            SkipReason::PathClash => {
                format!("- {path}: skipped, a file and a folder share this path")
            }
            SkipReason::OtherDirection => {
                format!("- {path}: changed on the other side (run `nubes sync`)")
            }
        },
    }
}

fn commit_message(p: &Plan, remote: &RemoteState, device: &str) -> String {
    let (mut added, mut updated) = (0, 0);
    for a in &p.actions {
        match a {
            Action::Upload { path, .. } if remote.files.contains_key(path) => updated += 1,
            Action::Upload { .. } | Action::Conflict { upload: true, .. } => added += 1,
            _ => {}
        }
    }
    let deleted = p.summary.delete_remote;
    let mut parts = Vec::new();
    if added > 0 {
        parts.push(format!("{added} added"));
    }
    if updated > 0 {
        parts.push(format!("{updated} updated"));
    }
    if deleted > 0 {
        parts.push(format!("{deleted} deleted"));
    }
    format!("nubes: {} (from {device})", parts.join(", "))
}

fn mode_for(local: Option<&LocalFile>, remote: Option<&crate::github::RemoteFile>) -> String {
    match (local, remote) {
        (Some(l), _) if l.executable => "100755".into(),
        (Some(_), Some(r)) if r.mode == "100755" => "100644".into(),
        (_, Some(r)) => r.mode.clone(),
        _ => "100644".into(),
    }
}

/// Makes sure the bytes about to be uploaded are the ones that were planned.
fn read_verified(root: &Path, path: &str, sha: &str) -> Result<Vec<u8>> {
    let full = root.join(path);
    let data = fs::read(&full).with_context(|| format!("reading {}", full.display()))?;
    if nubes_core::git_blob_sha(&data) != sha {
        bail!("{path} changed during the sync: run it again");
    }
    Ok(data)
}

/// Whether the local file is still what the scan saw (so it is safe to replace or delete).
fn unchanged_since_scan(root: &Path, path: &str, scanned: Option<&LocalFile>) -> bool {
    let meta = fs::symlink_metadata(root.join(path)).ok();
    match (meta, scanned) {
        (None, None) => true,
        (Some(m), Some(s)) => m.is_file() && m.len() == s.size && mtime_ns(&m) == s.mtime,
        _ => false,
    }
}

struct Writer<'a> {
    folder: &'a Folder,
    n: u32,
}

impl Writer<'_> {
    /// Writes through `.nubes/tmp` and a rename: a reader never sees half a file.
    fn write(&mut self, path: &str, data: &[u8], executable: bool) -> Result<()> {
        let dest = self.folder.root.join(path);
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let tmp_dir = self.folder.tmp_dir();
        fs::create_dir_all(&tmp_dir)?;
        self.n += 1;
        let tmp = tmp_dir.join(format!("{}-{}", std::process::id(), self.n));
        fs::write(&tmp, data).with_context(|| format!("writing {}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if executable { 0o755 } else { 0o644 };
            fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        fs::rename(&tmp, &dest).with_context(|| format!("writing {}", dest.display()))?;
        Ok(())
    }
}

/// Removes now-empty parent folders of `path`, up to the synced root.
fn prune_dirs(root: &Path, path: &str) {
    let mut dir: Option<PathBuf> = root.join(path).parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if d == root || fs::remove_dir(&d).is_err() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
}

pub fn run(folder: &Folder, remote: &Remote<'_>, opts: &Options) -> Result<Outcome> {
    let ignore = folder.ignore_lines()?;
    let matcher = Matcher::new(&ignore).map_err(anyhow::Error::msg)?;
    for attempt in 0..5 {
        let state = folder.load_state()?;
        let mut rstate = remote.state()?;
        if (rstate.head.is_none() || !rstate.has_meta) && !opts.dry_run {
            remote.ensure_meta(&rstate)?;
            rstate = remote.state()?;
        }
        if !opts.dry_run {
            remote.unlock(&rstate)?;
        }
        if attempt == 0 && !opts.quiet {
            for f in &rstate.foreign {
                eprintln!("- {f}: left alone, not written by nubes in this encrypted folder");
            }
        }
        let local = scan(&folder.root, &state.files, &matcher)?;
        for s in &local.skipped {
            eprintln!("- {s}: skipped, not a valid nubes path");
        }
        let input = PlanInput {
            base: base_snapshot(&state),
            local: local_snapshot(&local.files),
            remote: remote_snapshot(&rstate),
            direction: opts.direction,
            ignore: ignore.clone(),
            device: folder.config.device.clone(),
            stamp: util::stamp(util::now_secs()),
            // Encryption adds a little: keep the sealed blob under the limit.
            max_size: rstate.encrypted.then_some(nubes_core::GITHUB_MAX_ENCRYPTED),
        };
        let p = plan(&input).map_err(anyhow::Error::msg)?;
        if opts.dry_run {
            return Ok(Outcome {
                plan: p,
                commit: None,
            });
        }

        // 1. Remote side, in a single commit.
        let mut changes = Vec::new();
        for a in &p.actions {
            match a {
                Action::Upload { path, sha, .. } => {
                    if !remote.has(sha, &rstate) {
                        let data = read_verified(&folder.root, path, sha)?;
                        remote.put(&data, sha, &rstate)?;
                    }
                    changes.push(Change {
                        path: path.clone(),
                        mode: mode_for(local.files.get(path), rstate.files.get(path)),
                        sha: Some(sha.clone()),
                    });
                }
                Action::DeleteRemote { path } => changes.push(Change {
                    path: path.clone(),
                    mode: "100644".into(),
                    sha: None,
                }),
                Action::Conflict {
                    path,
                    renamed_to,
                    local_sha,
                    upload: true,
                    ..
                } => {
                    if !remote.has(local_sha, &rstate) {
                        let data = read_verified(&folder.root, path, local_sha)?;
                        remote.put(&data, local_sha, &rstate)?;
                    }
                    changes.push(Change {
                        path: renamed_to.clone(),
                        mode: mode_for(local.files.get(path), None),
                        sha: Some(local_sha.clone()),
                    });
                }
                _ => {}
            }
        }
        let head = rstate.head.clone().unwrap_or_default();
        let new_head = if changes.is_empty() {
            rstate.head.clone()
        } else {
            let msg = commit_message(&p, &rstate, &folder.config.device);
            match remote.commit(&changes, &msg, &rstate) {
                Ok(c) => Some(c),
                Err(e) if e.downcast_ref::<RefMoved>().is_some() => {
                    if !opts.quiet {
                        eprintln!(
                            "the repository changed meanwhile, planning again ({})",
                            attempt + 1
                        );
                    }
                    continue;
                }
                Err(e) => return Err(e),
            }
        };

        // 2. Local side. What the folder now holds, for the hash cache.
        let mut known: BTreeMap<String, String> = local
            .files
            .iter()
            .map(|(p, f)| (p.clone(), f.sha.clone()))
            .collect();
        let mut writer = Writer { folder, n: 0 };
        let mut failed = false;
        for a in &p.actions {
            match a {
                Action::Download { path, sha, .. } => {
                    if !unchanged_since_scan(&folder.root, path, local.files.get(path)) {
                        eprintln!("! {path} changed during the sync, left as is (run sync again)");
                        failed = true;
                        continue;
                    }
                    let data = remote.get(sha)?;
                    if nubes_core::git_blob_sha(&data) != *sha {
                        bail!("downloaded {path} does not match its id {sha}");
                    }
                    let exec = rstate.files.get(path).is_some_and(|f| f.mode == "100755");
                    writer.write(path, &data, exec)?;
                    known.insert(path.clone(), sha.clone());
                }
                Action::DeleteLocal { path } => {
                    if !unchanged_since_scan(&folder.root, path, local.files.get(path)) {
                        eprintln!("! {path} changed during the sync, not deleted (run sync again)");
                        failed = true;
                        continue;
                    }
                    fs::remove_file(folder.root.join(path))
                        .with_context(|| format!("deleting {path}"))?;
                    prune_dirs(&folder.root, path);
                    known.remove(path);
                }
                Action::Conflict {
                    path,
                    renamed_to,
                    local_sha,
                    remote_sha,
                    ..
                } => {
                    if !unchanged_since_scan(&folder.root, path, local.files.get(path)) {
                        eprintln!("! {path} changed during the sync, left as is (run sync again)");
                        failed = true;
                        continue;
                    }
                    let to = folder.root.join(renamed_to);
                    if to.exists() {
                        bail!("{renamed_to} already exists");
                    }
                    fs::rename(folder.root.join(path), &to)
                        .with_context(|| format!("renaming {path} to {renamed_to}"))?;
                    known.insert(renamed_to.clone(), local_sha.clone());
                    known.remove(path);
                    let data = remote.get(remote_sha)?;
                    if nubes_core::git_blob_sha(&data) != *remote_sha {
                        bail!("downloaded {path} does not match its id {remote_sha}");
                    }
                    let exec = rstate.files.get(path).is_some_and(|f| f.mode == "100755");
                    writer.write(path, &data, exec)?;
                    known.insert(path.clone(), remote_sha.clone());
                }
                _ => {}
            }
        }

        // 3. The new base. A file's mtime is cached only when its content is
        // known to be the base's, and not if it is so recent that a later write
        // in the same clock tick could go unnoticed.
        let recent = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
            .saturating_sub(2_000_000_000);
        let mut files = BTreeMap::new();
        for (path, e) in &p.next_base {
            let mut fsx = FileState {
                sha: e.sha.clone(),
                size: e.size,
                mtime: 0,
            };
            if known.get(path) == Some(&e.sha) {
                if let Ok(m) = fs::metadata(folder.root.join(path)) {
                    let t = mtime_ns(&m);
                    if t < recent {
                        fsx.mtime = t;
                    }
                    fsx.size = m.len();
                }
            }
            files.insert(path.clone(), fsx);
        }
        if failed {
            // Keep the old base for the files that were left alone.
            for (path, old) in &state.files {
                if !unchanged_since_scan(&folder.root, path, local.files.get(path)) {
                    files.insert(path.clone(), old.clone());
                }
            }
        }
        folder.save_state(&State {
            head: new_head.clone(),
            files,
        })?;
        let _ = fs::remove_dir(folder.tmp_dir());
        return Ok(Outcome {
            commit: new_head.filter(|h| *h != head && !changes.is_empty()),
            plan: p,
        });
    }
    bail!("the repository kept changing during the sync; try again")
}

/// Quiet time after a file event before syncing (an editor saving, a copy in progress).
const DEBOUNCE: Duration = Duration::from_secs(2);
/// A burst of events never delays a sync longer than this.
const DEBOUNCE_MAX: Duration = Duration::from_secs(20);
/// Full rescan even without events, in case the platform dropped some.
const RESCAN: Duration = Duration::from_secs(300);

/// Whether the folder differs from the last synced base (a cheap scan: the
/// hash cache skips unchanged files).
fn local_changed(folder: &Folder, matcher: &Matcher) -> Result<bool> {
    let state = folder.load_state()?;
    let local = scan(&folder.root, &state.files, matcher)?;
    let local_snap = local_snapshot(&local.files);
    let base = base_snapshot(&state);
    Ok(local_snap.len() != base.len()
        || !local_snap
            .iter()
            .all(|(p, e)| base.get(p).is_some_and(|b| b.sha == e.sha)))
}

fn sync_once(folder: &Folder, remote: &Remote<'_>) {
    let opts = Options {
        direction: Direction::Both,
        dry_run: false,
        quiet: true,
    };
    match run(folder, remote, &opts) {
        Ok(out) => {
            for a in &out.plan.actions {
                println!("{}", describe(a));
            }
            if let Some(c) = out.commit {
                println!("committed {}", &c[..7.min(c.len())]);
            }
        }
        Err(e) => eprintln!("sync failed: {e:#}"),
    }
}

/// Watches the folder for file events (synced after 2 s of quiet) and polls
/// the branch every `interval` with its ETag (an unchanged branch costs no
/// rate limit). Without file events (unsupported file system), scans the
/// folder every `interval` instead.
pub fn watch(folder: &Folder, remote: &Remote<'_>, interval: Duration) -> Result<()> {
    use notify::{RecursiveMode, Watcher};
    use std::sync::mpsc::{channel, RecvTimeoutError};

    let ignore = folder.ignore_lines()?;
    let matcher = Matcher::new(&ignore).map_err(anyhow::Error::msg)?;
    let (tx, rx) = channel::<()>();
    let own = folder.root.join(crate::config::DIR);
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        // nubes' own state (.nubes/) changes on every sync: not a reason to sync.
        if res.is_ok_and(|ev| ev.paths.iter().any(|p| !p.starts_with(&own))) {
            let _ = tx.send(());
        }
    });
    let watcher = watcher.and_then(|mut w| {
        w.watch(&folder.root, RecursiveMode::Recursive)?;
        Ok(w)
    });
    let live = match &watcher {
        Ok(_) => true,
        Err(e) => {
            eprintln!(
                "file events unavailable ({e}), scanning every {}s",
                interval.as_secs()
            );
            false
        }
    };
    eprintln!(
        "watching {} ⇄ {} (remote checked every {}s; Ctrl-C to stop)",
        folder.root.display(),
        remote.full,
        interval.as_secs()
    );
    let rescan = if live { RESCAN } else { interval };
    let mut etag: Option<String> = None;
    let mut next_poll = Instant::now() + interval;
    let mut next_scan = Instant::now() + rescan;
    let mut pending = true; // the first round always syncs
    loop {
        if pending {
            sync_once(folder, remote);
            // Edits made during the sync are caught by the check below
            // (the sync's own writes match the new base: no second sync).
            pending = false;
            next_scan = Instant::now();
        }
        let mut check_local = false;
        let wait = next_poll
            .min(next_scan)
            .saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
            Ok(()) => {
                let burst = Instant::now();
                while burst.elapsed() < DEBOUNCE_MAX {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(()) => continue,
                        Err(_) => break,
                    }
                }
                check_local = true;
            }
            Err(RecvTimeoutError::Timeout) => {}
            // No watcher: nothing will ever be sent.
            Err(RecvTimeoutError::Disconnected) => std::thread::sleep(wait),
        }
        let now = Instant::now();
        if now >= next_scan {
            check_local = true;
            next_scan = now + rescan;
        }
        if check_local {
            match local_changed(folder, &matcher) {
                Ok(changed) => pending |= changed,
                Err(e) => eprintln!("scan failed: {e:#}"),
            }
        }
        if now >= next_poll {
            next_poll = now + interval;
            match remote
                .gh
                .head_if_changed(&remote.full, &remote.branch, etag.as_deref())
            {
                Ok(Poll::NotModified) => {}
                Ok(Poll::Changed { head, etag: e }) => {
                    etag = e;
                    pending |= folder.load_state().map(|s| s.head != head).unwrap_or(true);
                }
                Err(e) => eprintln!("checking the repository failed: {e:#}"),
            }
        }
    }
}

/// Hash of one local file, for `restore` and tests.
pub fn local_sha(folder: &Folder, path: &str) -> Result<Option<String>> {
    let p = folder.root.join(path);
    match fs::metadata(&p) {
        Ok(m) if m.is_file() => Ok(Some(hash_file(&p, m.len())?)),
        _ => Ok(None),
    }
}
