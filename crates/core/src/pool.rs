//! A pool: one nubes folder spread over several repositories
//! (`<name>-1`, `<name>-2`…), so that none of them grows past a size limit.
//!
//! The planner (`plan.rs`) does not know about pools: it plans against the
//! union of the members' trees ([`merge`]), and [`place`] then decides which
//! member each remote change goes to.
//!
//! Rules:
//! - a path lives in a single member, its *owner*. A change to an existing
//!   path always goes to its owner, so a file never moves between
//!   repositories (no commit ever has to span two of them);
//! - a new path goes to the first member (lowest index) with room that
//!   already holds the same content (a rename costs no upload), else to the
//!   first member with room, else to a new member;
//! - a member has room for a file if its size, plus what this sync already
//!   placed in it, plus the file stays within the limit. An empty member
//!   always takes one file, so a file larger than the limit gets a member
//!   of its own instead of creating members forever;
//! - two devices may add the same new path to two members at once: the
//!   lowest index keeps the path; the other copy is deleted if identical,
//!   else renamed to a conflict copy in its member. Nothing is lost.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::path::conflict_name;
use crate::plan::Snapshot;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// `n` in `<name>-<n>`, from 1.
    pub index: u32,
    /// Bytes the repository already takes (GitHub's `size`).
    #[serde(default)]
    pub used: u64,
    /// Its files (nubes paths, plain ids).
    #[serde(default)]
    pub files: Snapshot,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeInput {
    #[serde(default)]
    pub members: Vec<Member>,
    /// Go into the names of conflict copies.
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub stamp: String,
}

/// A remote change: `sha: None` deletes `path`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub size: u64,
}

/// A change already tied to a member (clean-up of a duplicate path).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixup {
    pub member: u32,
    #[serde(flatten)]
    pub change: Change,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// The union of the members, as the planner's `remote`.
    pub files: Snapshot,
    /// Path → index of the member that holds it.
    pub owner: BTreeMap<String, u32>,
    /// Changes that resolve duplicate paths; `files` already reflects them.
    pub fixups: Vec<Fixup>,
}

/// The union of the members' trees, duplicates resolved.
pub fn merge(input: &MergeInput) -> View {
    let mut members: Vec<&Member> = input.members.iter().collect();
    members.sort_by_key(|m| m.index);
    let mut v = View::default();
    let taken = |p: &str| members.iter().any(|m| m.files.contains_key(p));
    let mut renamed: Vec<String> = Vec::new();
    for m in &members {
        for (path, e) in &m.files {
            let Some(kept) = v.files.get(path) else {
                v.files.insert(path.clone(), e.clone());
                v.owner.insert(path.clone(), m.index);
                continue;
            };
            v.fixups.push(Fixup {
                member: m.index,
                change: Change {
                    path: path.clone(),
                    sha: None,
                    size: 0,
                },
            });
            if kept.sha == e.sha {
                continue;
            }
            let to = conflict_name(path, &input.device, &input.stamp, &|c| {
                taken(c) || renamed.iter().any(|r| r == c)
            });
            renamed.push(to.clone());
            v.fixups.push(Fixup {
                member: m.index,
                change: Change {
                    path: to.clone(),
                    sha: Some(e.sha.clone()),
                    size: e.size,
                },
            });
            v.files.insert(to.clone(), e.clone());
            v.owner.insert(to, m.index);
        }
    }
    v
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceInput {
    #[serde(default)]
    pub members: Vec<Member>,
    /// From [`View::owner`].
    #[serde(default)]
    pub owner: BTreeMap<String, u32>,
    /// From [`View::fixups`].
    #[serde(default)]
    pub fixups: Vec<Fixup>,
    /// Size limit of a member, in bytes; `None`: no limit, no new member.
    #[serde(default)]
    pub limit: Option<u64>,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assigned {
    pub index: u32,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    /// One entry per member to commit to, in commit order: members that
    /// receive files first, members that only lose some last (a failure in
    /// between never leaves a file nowhere).
    pub members: Vec<Assigned>,
    /// New members to create first (indexes after the last member).
    pub create: u32,
}

/// Assigns each change to a member.
pub fn place(input: &PlaceInput) -> Placement {
    struct Slot<'a> {
        index: u32,
        used: u64,
        files: Option<&'a Snapshot>,
        changes: Vec<Change>,
    }
    let mut slots: Vec<Slot> = input
        .members
        .iter()
        .map(|m| Slot {
            index: m.index,
            used: m.used,
            files: Some(&m.files),
            changes: Vec::new(),
        })
        .collect();
    slots.sort_by_key(|s| s.index);
    let existing = slots.len();
    let fits = |s: &Slot, size: u64| match input.limit {
        None => true,
        Some(limit) => s.used == 0 || s.used.saturating_add(size) <= limit,
    };
    let holds = |s: &Slot, sha: &str| {
        s.files.is_some_and(|f| f.values().any(|e| e.sha == sha))
            || s.changes.iter().any(|c| c.sha.as_deref() == Some(sha))
    };

    for f in &input.fixups {
        if let Some(s) = slots.iter_mut().find(|s| s.index == f.member) {
            s.changes.push(f.change.clone());
        }
    }
    for c in &input.changes {
        let at = if let Some(owner) = input.owner.get(&c.path) {
            slots.iter().position(|s| s.index == *owner)
        } else if let Some(sha) = &c.sha {
            let pick = slots
                .iter()
                .position(|s| fits(s, c.size) && holds(s, sha))
                .or_else(|| slots.iter().position(|s| fits(s, c.size)));
            match pick {
                Some(i) => Some(i),
                None => {
                    let index = slots.last().map_or(1, |s| s.index + 1);
                    slots.push(Slot {
                        index,
                        used: 0,
                        files: None,
                        changes: Vec::new(),
                    });
                    Some(slots.len() - 1)
                }
            }
        } else {
            None // deleting a path no member holds: nothing to do
        };
        if let Some(i) = at {
            let s = &mut slots[i];
            if c.sha.is_some() {
                s.used = s.used.saturating_add(c.size.max(1));
            }
            s.changes.push(c.clone());
        }
    }

    let create = (slots.len() - existing) as u32;
    let adds = |s: &Slot| s.changes.iter().any(|c| c.sha.is_some());
    let (mut first, last): (Vec<_>, Vec<_>) = slots
        .into_iter()
        .filter(|s| !s.changes.is_empty())
        .partition(adds);
    first.extend(last);
    Placement {
        members: first
            .into_iter()
            .map(|s| Assigned {
                index: s.index,
                changes: s.changes,
            })
            .collect(),
        create,
    }
}
