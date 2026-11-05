//! The three-way sync planner.
//!
//! Inputs are three snapshots, each a map from path to git blob id:
//! - `base`: both sides as of the last successful sync;
//! - `local`: the folder now;
//! - `remote`: the repository's tree now.
//!
//! For each path the planner compares the three ids and decides what to do.
//! It never reads a file or calls the network: the caller executes the plan
//! (remote side in a single commit, then the local side) and, once both
//! sides succeeded, stores `next_base` as the new base.
//!
//! Rules, per path, in direction `both`:
//! - same on both sides: nothing to do;
//! - changed on one side only: copy it to the other side (upload,
//!   download, or propagate the deletion);
//! - changed on both sides, to different contents: keep both, the local
//!   copy renamed `name.conflict-<device>-<stamp>.ext`;
//! - deleted on one side, modified on the other: the modification wins.
//!
//! `push` and `pull` only apply changes in one direction. A deletion never
//! destroys a change the other side has not seen, and `pull` never loses an
//! unpushed local edit (it becomes a conflict copy that the next sync uploads).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::ignore::Matcher;
use crate::path::{conflict_name, is_safe_path};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Git blob id (40 hex chars).
    pub sha: String,
    /// Size in bytes (informational, and checked against `max_size`).
    #[serde(default)]
    pub size: u64,
}

pub type Snapshot = BTreeMap<String, Entry>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Both,
    Push,
    Pull,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    #[serde(default)]
    pub base: Snapshot,
    #[serde(default)]
    pub local: Snapshot,
    #[serde(default)]
    pub remote: Snapshot,
    #[serde(default)]
    pub direction: Direction,
    /// Lines of `.nubesignore` (the defaults are always applied).
    #[serde(default)]
    pub ignore: Vec<String>,
    /// Goes into conflict copy names.
    #[serde(default)]
    pub device: String,
    /// `YYYYMMDD-HHMM`, goes into conflict copy names.
    #[serde(default)]
    pub stamp: String,
    /// Files larger than this are not uploaded (GitHub's limit by default).
    #[serde(default)]
    pub max_size: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// Larger than `max_size`.
    TooLarge,
    /// Not a valid nubes path (see `is_safe_path`).
    UnsafePath,
    /// A file and a directory would have the same path.
    PathClash,
    /// Changed only on the side this direction does not read from.
    OtherDirection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    /// Send the local file to the remote.
    Upload {
        path: String,
        sha: String,
        size: u64,
    },
    /// Write the remote blob to the local path.
    Download {
        path: String,
        sha: String,
        size: u64,
    },
    /// Remove the local file.
    DeleteLocal { path: String },
    /// Remove the remote file.
    DeleteRemote { path: String },
    /// Rename the local file to `renamed_to` (and upload it under that name
    /// if `upload`), then download the remote version to `path`.
    Conflict {
        path: String,
        renamed_to: String,
        local_sha: String,
        local_size: u64,
        remote_sha: String,
        remote_size: u64,
        upload: bool,
    },
    /// Left as is, for `reason`.
    Skip { path: String, reason: SkipReason },
}

impl Action {
    pub fn path(&self) -> &str {
        match self {
            Action::Upload { path, .. }
            | Action::Download { path, .. }
            | Action::DeleteLocal { path }
            | Action::DeleteRemote { path }
            | Action::Conflict { path, .. }
            | Action::Skip { path, .. } => path,
        }
    }

    /// Whether executing this action changes the remote tree.
    pub fn touches_remote(&self) -> bool {
        matches!(
            self,
            Action::Upload { .. }
                | Action::DeleteRemote { .. }
                | Action::Conflict { upload: true, .. }
        )
    }

    /// Whether executing this action changes the local folder.
    pub fn touches_local(&self) -> bool {
        matches!(
            self,
            Action::Download { .. } | Action::DeleteLocal { .. } | Action::Conflict { .. }
        )
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub uploads: usize,
    pub downloads: usize,
    pub delete_local: usize,
    pub delete_remote: usize,
    pub conflicts: usize,
    pub skipped: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub actions: Vec<Action>,
    /// The base to store once every action succeeded.
    pub next_base: Snapshot,
    pub summary: Summary,
}

impl Plan {
    pub fn is_noop(&self) -> bool {
        self.actions
            .iter()
            .all(|a| matches!(a, Action::Skip { .. }))
    }
}

fn same(a: Option<&Entry>, b: Option<&Entry>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x.sha == y.sha,
        _ => false,
    }
}

/// Plans a sync. Fails only on an invalid ignore pattern.
pub fn plan(input: &PlanInput) -> Result<Plan, String> {
    let matcher = Matcher::new(&input.ignore)?;
    let keep = |p: &String| !matcher.is_ignored(p);
    let base: Snapshot = input
        .base
        .iter()
        .filter(|(p, _)| keep(p))
        .map(clone_kv)
        .collect();
    let local: Snapshot = input
        .local
        .iter()
        .filter(|(p, _)| keep(p))
        .map(clone_kv)
        .collect();
    let remote: Snapshot = input
        .remote
        .iter()
        .filter(|(p, _)| keep(p))
        .map(clone_kv)
        .collect();
    let max = input.max_size.unwrap_or(crate::GITHUB_MAX_BLOB);
    let dir = input.direction;

    let paths: BTreeSet<&String> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();
    let mut taken: BTreeSet<String> = paths.iter().map(|p| (*p).clone()).collect();
    let mut actions = Vec::new();
    let mut next_base = Snapshot::new();

    for p in paths {
        let (b, l, r) = (base.get(p), local.get(p), remote.get(p));
        let keep_base = |nb: &mut Snapshot| {
            if let Some(e) = b {
                nb.insert(p.clone(), e.clone());
            }
        };

        if same(l, r) {
            if let Some(e) = l {
                next_base.insert(p.clone(), e.clone());
            }
            continue;
        }
        if !is_safe_path(p) {
            actions.push(skip(p, SkipReason::UnsafePath));
            keep_base(&mut next_base);
            continue;
        }

        let local_changed = !same(l, b);
        let remote_changed = !same(r, b);

        // What each side would like to do, before the direction filter.
        let push_side = local_changed;
        let pull_side = remote_changed;

        let action = match (push_side, pull_side) {
            (true, false) => to_remote(p, l),
            (false, true) => to_local(p, r),
            (true, true) => match (l, r) {
                // Deleted here, modified there: the modification wins.
                (None, Some(_)) => to_local(p, r),
                (Some(_), None) => to_remote(p, l),
                (Some(le), Some(re)) => {
                    let renamed =
                        conflict_name(p, &input.device, &input.stamp, &|c| taken.contains(c));
                    taken.insert(renamed.clone());
                    Action::Conflict {
                        path: p.clone(),
                        renamed_to: renamed,
                        local_sha: le.sha.clone(),
                        local_size: le.size,
                        remote_sha: re.sha.clone(),
                        remote_size: re.size,
                        upload: true,
                    }
                }
                (None, None) => unreachable!("same(l, r) handled above"),
            },
            (false, false) => unreachable!("l != r implies one side changed"),
        };

        let action = filter_direction(action, dir, l, r, b);
        let action = match action {
            Action::Upload { size, .. } if size > max => skip(p, SkipReason::TooLarge),
            Action::Conflict {
                path,
                renamed_to,
                local_sha,
                local_size,
                remote_sha,
                remote_size,
                upload,
            } => Action::Conflict {
                upload: upload && dir != Direction::Pull && local_size <= max,
                path,
                renamed_to,
                local_sha,
                local_size,
                remote_sha,
                remote_size,
            },
            a => a,
        };

        apply_to_base(&action, b, l, r, &mut next_base);
        actions.push(action);
    }

    check_clashes(&mut actions, &remote, &local, &base, &mut next_base);

    let mut summary = Summary::default();
    for a in &actions {
        match a {
            Action::Upload { .. } => summary.uploads += 1,
            Action::Download { .. } => summary.downloads += 1,
            Action::DeleteLocal { .. } => summary.delete_local += 1,
            Action::DeleteRemote { .. } => summary.delete_remote += 1,
            Action::Conflict { .. } => summary.conflicts += 1,
            Action::Skip { .. } => summary.skipped += 1,
        }
    }
    Ok(Plan {
        actions,
        next_base,
        summary,
    })
}

fn clone_kv((p, e): (&String, &Entry)) -> (String, Entry) {
    (p.clone(), e.clone())
}

fn skip(p: &str, reason: SkipReason) -> Action {
    Action::Skip {
        path: p.to_string(),
        reason,
    }
}

fn to_remote(p: &str, l: Option<&Entry>) -> Action {
    match l {
        Some(e) => Action::Upload {
            path: p.to_string(),
            sha: e.sha.clone(),
            size: e.size,
        },
        None => Action::DeleteRemote {
            path: p.to_string(),
        },
    }
}

fn to_local(p: &str, r: Option<&Entry>) -> Action {
    match r {
        Some(e) => Action::Download {
            path: p.to_string(),
            sha: e.sha.clone(),
            size: e.size,
        },
        None => Action::DeleteLocal {
            path: p.to_string(),
        },
    }
}

/// Restricts an action to one direction (`push` or `pull`).
fn filter_direction(
    action: Action,
    dir: Direction,
    l: Option<&Entry>,
    r: Option<&Entry>,
    b: Option<&Entry>,
) -> Action {
    let p = action.path().to_string();
    match dir {
        Direction::Both => action,
        Direction::Push => match action {
            Action::Upload { .. } | Action::DeleteRemote { .. } => {
                // A local deletion must not erase a remote change it never saw.
                if l.is_none() && !same(r, b) {
                    skip(&p, SkipReason::OtherDirection)
                } else {
                    action
                }
            }
            // Both sides edited: push means the local version wins. The
            // remote one stays in the repository's history.
            Action::Conflict {
                path,
                local_sha,
                local_size,
                ..
            } => Action::Upload {
                path,
                sha: local_sha,
                size: local_size,
            },
            _ => skip(&p, SkipReason::OtherDirection),
        },
        Direction::Pull => match action {
            Action::Download { .. } => action,
            // Only when the local copy is unchanged: otherwise it is not in
            // the remote history and deleting it would lose it.
            Action::DeleteLocal { .. } if same(l, b) => action,
            Action::Conflict { .. } => action,
            _ => skip(&p, SkipReason::OtherDirection),
        },
    }
}

fn apply_to_base(
    action: &Action,
    b: Option<&Entry>,
    l: Option<&Entry>,
    r: Option<&Entry>,
    nb: &mut Snapshot,
) {
    match action {
        Action::Upload { path, .. } => {
            if let Some(e) = l {
                nb.insert(path.clone(), e.clone());
            }
        }
        Action::Download { path, .. } => {
            if let Some(e) = r {
                nb.insert(path.clone(), e.clone());
            }
        }
        Action::DeleteLocal { .. } | Action::DeleteRemote { .. } => {}
        Action::Conflict {
            path,
            renamed_to,
            local_sha,
            local_size,
            upload,
            ..
        } => {
            if let Some(e) = r {
                nb.insert(path.clone(), e.clone());
            }
            if *upload {
                nb.insert(
                    renamed_to.clone(),
                    Entry {
                        sha: local_sha.clone(),
                        size: *local_size,
                    },
                );
            }
        }
        Action::Skip { path, .. } => {
            if let Some(e) = b {
                nb.insert(path.clone(), e.clone());
            }
        }
    }
}

/// Git cannot have `a` as a file and `a/b` as a file in the same tree, nor
/// can a folder. Any action that would create such a clash, on either side,
/// is turned into a skip and the path keeps its old base.
fn check_clashes(
    actions: &mut [Action],
    remote: &Snapshot,
    local: &Snapshot,
    base: &Snapshot,
    next_base: &mut Snapshot,
) {
    // The trees the two sides would end up with.
    let mut final_remote: BTreeSet<String> = remote.keys().cloned().collect();
    let mut final_local: BTreeSet<String> = local.keys().cloned().collect();
    for a in actions.iter() {
        match a {
            Action::Upload { path, .. } => {
                final_remote.insert(path.clone());
            }
            Action::DeleteRemote { path } => {
                final_remote.remove(path);
            }
            Action::Download { path, .. } => {
                final_local.insert(path.clone());
            }
            Action::DeleteLocal { path } => {
                final_local.remove(path);
            }
            Action::Conflict {
                path,
                renamed_to,
                upload,
                ..
            } => {
                final_local.insert(path.clone());
                final_local.insert(renamed_to.clone());
                if *upload {
                    final_remote.insert(renamed_to.clone());
                }
            }
            Action::Skip { .. } => {}
        }
    }
    let clashes = |set: &BTreeSet<String>, p: &str| -> bool {
        // An ancestor of p is a file, or p is an ancestor of a file.
        let mut prefix = String::new();
        for part in p.split('/') {
            if !prefix.is_empty() {
                if set.contains(&prefix) {
                    return true;
                }
                prefix.push('/');
            }
            prefix.push_str(part);
        }
        let as_dir = format!("{p}/");
        set.range(as_dir.clone()..)
            .next()
            .is_some_and(|q| q.starts_with(&as_dir))
    };
    for a in actions.iter_mut() {
        let bad = match a {
            Action::Upload { path, .. } => clashes(&final_remote, path),
            Action::Download { path, .. } => clashes(&final_local, path),
            Action::Conflict {
                path,
                renamed_to,
                upload,
                ..
            } => {
                clashes(&final_local, path)
                    || clashes(&final_local, renamed_to)
                    || (*upload && clashes(&final_remote, renamed_to))
            }
            _ => false,
        };
        if bad {
            let p = a.path().to_string();
            if let Action::Conflict {
                renamed_to,
                upload: true,
                ..
            } = a
            {
                next_base.remove(renamed_to.as_str());
            }
            match base.get(&p) {
                Some(e) => {
                    next_base.insert(p.clone(), e.clone());
                }
                None => {
                    next_base.remove(&p);
                }
            }
            *a = skip(&p, SkipReason::PathClash);
        }
    }
}
