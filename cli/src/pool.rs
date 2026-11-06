//! The remote side of a folder: one repository, or a pool of them
//! (`owner/name-1`, `owner/name-2`…) that nubes creates as they fill up.
//!
//! The rules (which member holds a path, where a new file goes, duplicate
//! paths) are nubes-core's `merge` and `place`, shared with the web app.
//! A folder linked to one repository is a pool of one member, without a
//! size limit.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};

use anyhow::{bail, Context, Result};
use nubes_core::{Entry, Member, MergeInput, PlaceInput, Placement, PoolChange, Snapshot, View};

use crate::config::{Config, MemberState, PoolConfig, State};
use crate::crypt::Cipher;
use crate::github::{GitHub, Remote, RemoteFile, RemoteState};

pub struct Pool<'a> {
    pub gh: &'a GitHub,
    /// None: a folder linked to one repository.
    pub auto: Option<PoolConfig>,
    /// Member `n` is `members[n - 1]`.
    pub members: Vec<Remote<'a>>,
    /// Members whose meta.json says they belong to the pool (or that nubes created).
    verified: RefCell<HashSet<String>>,
}

/// The members' trees and their union.
pub struct PoolState {
    /// Same order as [`Pool::members`].
    pub members: Vec<RemoteState>,
    pub view: View,
}

impl PoolState {
    /// Position in [`Pool::members`] of the member that holds `path`.
    pub fn owner(&self, path: &str) -> Option<usize> {
        self.view.owner.get(path).map(|i| (*i - 1) as usize)
    }

    pub fn file(&self, path: &str) -> Option<&RemoteFile> {
        self.members[self.owner(path)?].files.get(path)
    }

    pub fn encrypted(&self) -> bool {
        self.members.iter().any(|m| m.encrypted)
    }

    pub fn file_count(&self) -> usize {
        self.view.files.len()
    }
}

fn snapshot(r: &RemoteState) -> Snapshot {
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

impl<'a> Pool<'a> {
    /// The folder's remote side, with the members `state` knows of; call
    /// [`Pool::discover`] to find members other devices created since.
    pub fn open(gh: &'a GitHub, config: &Config, state: &State) -> Self {
        let Some(p) = &config.pool else {
            let r = Remote::new(gh, &config.repo, &config.branch, &config.prefix);
            return Self {
                gh,
                auto: None,
                verified: RefCell::new(HashSet::from([r.full.clone()])),
                members: vec![r],
            };
        };
        let mut pool = Self::new(gh, p.clone());
        for (i, m) in state.members.iter().enumerate() {
            let r = Remote::member(gh, p, i as u32 + 1, &m.branch);
            if r.full != m.repo {
                break; // a hand-edited state: discover again
            }
            pool.verified.borrow_mut().insert(r.full.clone());
            pool.members.push(r);
        }
        pool
    }

    /// A pool without known members yet.
    pub fn new(gh: &'a GitHub, auto: PoolConfig) -> Self {
        Self {
            gh,
            auto: Some(auto),
            members: Vec::new(),
            verified: RefCell::new(HashSet::new()),
        }
    }

    /// Adds the members that exist after the known ones; whether there were any.
    pub fn discover(&mut self) -> Result<bool> {
        let Some(p) = self.auto.clone() else {
            return Ok(false);
        };
        let mut found = false;
        loop {
            let n = self.members.len() as u32 + 1;
            let Some(info) = self.gh.repo_info(&format!("{}/{}-{n}", p.owner, p.name))? else {
                return Ok(found);
            };
            self.members
                .push(Remote::member(self.gh, &p, n, &info.default_branch));
            found = true;
        }
    }

    /// What `.nubes/state.json` records of the members.
    pub fn member_states(&self) -> Vec<MemberState> {
        if self.auto.is_none() {
            return Vec::new();
        }
        self.members
            .iter()
            .map(|m| MemberState {
                repo: m.full.clone(),
                branch: m.branch.clone(),
            })
            .collect()
    }

    /// Reads every member (refusing a repository of the pool's name that
    /// belongs to something else), and their union.
    pub fn state(&self, device: &str, stamp: &str) -> Result<PoolState> {
        let mut members = Vec::with_capacity(self.members.len());
        for m in &self.members {
            let s = m.state()?;
            if let Some(p) = &self.auto {
                if !self.verified.borrow().contains(&m.full) && s.head.is_some() {
                    let meta = m.read_meta(&s)?;
                    if meta.as_ref().and_then(|v| v["pool"].as_str()) != Some(p.name.as_str()) {
                        bail!(
                            "{} exists and is not part of the nubes pool {:?}: choose another name, or rename that repository",
                            m.full,
                            p.name
                        );
                    }
                }
                self.verified.borrow_mut().insert(m.full.clone());
            }
            members.push(s);
        }
        let view = nubes_core::merge(&MergeInput {
            members: members
                .iter()
                .enumerate()
                .map(|(i, s)| Member {
                    index: i as u32 + 1,
                    used: 0,
                    files: snapshot(s),
                })
                .collect(),
            device: device.to_string(),
            stamp: stamp.to_string(),
        });
        Ok(PoolState { members, view })
    }

    /// Gets the members ready to be written: meta.json in each, and in an
    /// encrypted pool the key everywhere. Whether a member changed (read
    /// the state again).
    pub fn ready(&self, ps: &PoolState) -> Result<bool> {
        let mut changed = false;
        for (m, s) in self.members.iter().zip(&ps.members) {
            if s.head.is_none() || !s.has_meta {
                m.ensure_meta(s)?;
                changed = true;
            }
        }
        if changed {
            return Ok(true);
        }
        let Some((first, secret)) = self.unlock(ps)? else {
            return Ok(false);
        };
        let mut key_file: Option<Vec<u8>> = None;
        for (m, s) in self.members.iter().zip(&ps.members) {
            if s.encrypted || self.auto.is_none() {
                continue;
            }
            if key_file.is_none() {
                let blob = ps.members[first].key_blob.as_deref().context("no key")?;
                key_file = Some(self.gh.blob(&self.members[first].full, blob)?);
            }
            m.adopt_key(key_file.as_deref().unwrap_or_default(), &secret)?;
            changed = true;
        }
        Ok(changed)
    }

    /// Unlocks an encrypted pool (one passphrase for every member): the
    /// first encrypted member and its key, or None for a plain pool.
    pub fn unlock(&self, ps: &PoolState) -> Result<Option<(usize, String)>> {
        let Some(first) = ps.members.iter().position(|s| s.encrypted) else {
            return Ok(None);
        };
        let m = &self.members[first];
        m.unlock(&ps.members[first])?;
        let secret = m.cipher_secret().context("the pool is locked")?;
        for (i, (m, s)) in self.members.iter().zip(&ps.members).enumerate() {
            if i != first && s.encrypted {
                m.set_cipher(Cipher::parse(&secret)?);
            }
        }
        Ok(Some((first, secret)))
    }

    /// Forgets the pool's key on this device.
    pub fn forget_key(&self) -> Result<bool> {
        match self.members.first() {
            Some(m) => m.forget_key(),
            None => Ok(false),
        }
    }

    /// Assigns each remote change to a member (`create` new ones first if needed).
    pub fn place(&self, ps: &PoolState, changes: &[PoolChange]) -> Result<Placement> {
        let limit = self.auto.as_ref().map(|p| p.max_size);
        // Room only matters for new paths: no need to ask GitHub otherwise.
        let new_paths = changes
            .iter()
            .any(|c| c.sha.is_some() && !ps.view.owner.contains_key(&c.path));
        let mut members = Vec::with_capacity(self.members.len());
        for (i, (m, s)) in self.members.iter().zip(&ps.members).enumerate() {
            let used = if limit.is_some() && new_paths {
                self.gh.repo_info(&m.full)?.map_or(0, |r| r.size)
            } else {
                0
            };
            members.push(Member {
                index: i as u32 + 1,
                used,
                files: snapshot(s),
            });
        }
        Ok(nubes_core::place(&PlaceInput {
            members,
            owner: ps.view.owner.clone(),
            fixups: ps.view.fixups.clone(),
            limit,
            changes: changes.to_vec(),
        }))
    }

    /// Creates `count` new members (private repositories) after the last one.
    pub fn create(&mut self, count: u32) -> Result<()> {
        let Some(p) = self.auto.clone() else {
            bail!("a folder linked to one repository does not create repositories");
        };
        for _ in 0..count {
            let n = self.members.len() as u32 + 1;
            let name = format!("{}-{n}", p.name);
            let full = format!("{}/{name}", p.owner);
            let description = format!("nubes storage: {} (part {n})", p.name);
            let branch = match self.gh.create_repo(&name, &description)? {
                Some(info) => {
                    self.verified.borrow_mut().insert(full.clone());
                    eprintln!("created the private repository {full}");
                    info.default_branch
                }
                // Another device created it meanwhile (`state` checks it is ours).
                None => {
                    self.gh
                        .repo_info(&full)?
                        .with_context(|| format!("{full} exists but cannot be read"))?
                        .default_branch
                }
            };
            let m = Remote::member(self.gh, &p, n, &branch);
            if self.verified.borrow().contains(&full) {
                m.ensure_meta(&m.state()?)?;
            }
            self.members.push(m);
        }
        Ok(())
    }

    /// The plain content of `path` (whose id is `sha`), from the member that holds it.
    pub fn get(&self, ps: &PoolState, path: &str, sha: &str) -> Result<Vec<u8>> {
        let i = ps
            .owner(path)
            .with_context(|| format!("{path} is in no repository"))?;
        self.members[i].get(sha)
    }

    /// Each member's commit, by repository.
    pub fn heads(&self, ps: &PoolState) -> BTreeMap<String, String> {
        self.members
            .iter()
            .zip(&ps.members)
            .filter_map(|(m, s)| Some((m.full.clone(), s.head.clone()?)))
            .collect()
    }

    /// For messages: `owner/repo`, or `owner/name-1…3`.
    pub fn describe(&self) -> String {
        match (&self.auto, self.members.len()) {
            (None, _) => self.members[0].full.clone(),
            (Some(p), 0 | 1) => format!("{}/{}-1", p.owner, p.name),
            (Some(p), n) => format!("{}/{}-1…{n}", p.owner, p.name),
        }
    }
}
