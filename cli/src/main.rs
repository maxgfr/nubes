//! nubes: sync a folder with a GitHub repository you own.

mod config;
mod creds;
mod github;
mod scan;
mod sync;
mod util;

use std::io::{IsTerminal, Read};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use nubes_core::Direction;

use crate::config::{parse_target, Config, Folder};
use crate::github::{GitHub, Remote};

const SKILL: &str = include_str!("../../skills/nubes/SKILL.md");
const VECTORS: &str = include_str!("../../crates/core/tests/vectors.json");

#[derive(Parser)]
#[command(
    name = "nubes",
    version,
    about = "Sync a folder with a GitHub repository you own.",
    after_help = "Web app: https://maxgfr.github.io/nubes/  ·  Docs: https://github.com/maxgfr/nubes"
)]
struct Cli {
    /// The synced folder (default: the current directory or one of its parents).
    #[arg(short = 'C', long, global = true, value_name = "DIR")]
    dir: Option<PathBuf>,

    /// GitHub API base URL (for GitHub Enterprise or tests).
    #[arg(long, global = true, env = "NUBES_API_URL", hide_env_values = true)]
    api: Option<String>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Store a GitHub token (a fine-grained token with Contents read/write).
    Login {
        /// Read the token from stdin instead of prompting.
        #[arg(long)]
        with_token: bool,
    },
    /// Forget the stored token.
    Logout,
    /// Show which account and token source are in use.
    Whoami,
    /// Link this folder to a repository: owner/repo or owner/repo:sub/folder.
    Init {
        target: String,
        /// Branch to sync (default: the repository's default branch).
        #[arg(long)]
        branch: Option<String>,
        /// Name of this device in commit messages and conflict copies.
        #[arg(long)]
        device: Option<String>,
    },
    /// Show what a sync would do, without changing anything.
    Status,
    /// Two-way sync.
    Sync {
        #[arg(long)]
        dry_run: bool,
    },
    /// Send local changes only.
    Push {
        #[arg(long)]
        dry_run: bool,
    },
    /// Fetch remote changes only.
    Pull {
        #[arg(long)]
        dry_run: bool,
    },
    /// Sync now, then again whenever either side changes.
    Watch {
        /// Seconds between checks.
        #[arg(long, default_value_t = 30)]
        interval: u64,
    },
    /// List the files in the repository.
    Ls {
        /// Only this folder.
        folder: Option<String>,
    },
    /// Commits that changed a path (or the whole folder).
    Log {
        path: Option<String>,
        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,
    },
    /// Write an older version of a file into the folder.
    Restore {
        path: String,
        /// The commit to take it from (see `nubes log <path>`).
        #[arg(long)]
        at: String,
    },
    /// Print the agent skill (SKILL.md) for coding agents.
    Skill,
    /// Check the engine against its test vectors.
    Selftest,
}

fn client(api: Option<String>) -> Result<GitHub> {
    let (token, _) = creds::token()?;
    Ok(GitHub::new(token, api))
}

fn start_dir(dir: &Option<PathBuf>) -> Result<PathBuf> {
    match dir {
        Some(d) => Ok(d.clone()),
        None => std::env::current_dir().context("no current directory"),
    }
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("nubes: {e:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.cmd {
        Cmd::Login { with_token } => {
            let token = if with_token || !std::io::stdin().is_terminal() {
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s)?;
                s.trim().to_string()
            } else {
                eprintln!("Create a fine-grained token with “Contents: Read and write” on your nubes repository:");
                eprintln!("  https://github.com/settings/personal-access-tokens/new?name=nubes&description=nubes+sync&contents=write");
                rpassword::prompt_password("Token: ")?.trim().to_string()
            };
            if token.is_empty() {
                bail!("no token given");
            }
            let login = GitHub::new(token.clone(), cli.api).user()?;
            creds::store(&token)?;
            println!(
                "signed in as {login} (token stored in {})",
                creds::store_name()
            );
        }
        Cmd::Logout => {
            if creds::remove()? {
                println!("token removed from {}", creds::store_name());
            } else {
                println!("no stored token");
            }
        }
        Cmd::Whoami => {
            let (token, source) = creds::token()?;
            let login = GitHub::new(token, cli.api).user()?;
            println!("{login} (token from {})", source.describe());
        }
        Cmd::Init {
            target,
            branch,
            device,
        } => {
            let root = start_dir(&cli.dir)?;
            std::fs::create_dir_all(&root)?;
            let (repo, prefix) = parse_target(&target)?;
            let gh = client(cli.api)?;
            let (default_branch, can_push) = gh.repo(&repo)?;
            if !can_push {
                bail!("the token cannot write to {repo}: give it “Contents: Read and write”");
            }
            let branch = branch.unwrap_or(default_branch);
            let config = Config {
                repo: repo.clone(),
                branch: branch.clone(),
                prefix: prefix.clone(),
                device: device.unwrap_or_else(util::device_name),
            };
            let folder = Folder::create(&root, config)?;
            let remote = Remote::new(&gh, &repo, &branch, &prefix);
            let state = remote.state()?;
            if remote.ensure_meta(&state)? {
                println!("initialized {repo} for nubes");
            }
            let where_ = if prefix.is_empty() {
                String::new()
            } else {
                format!(":{prefix}")
            };
            println!(
                "linked {} to {repo}{where_} ({branch}), {} remote file(s). Next: nubes status, then nubes sync",
                folder.root.display(),
                state.files.len()
            );
        }
        Cmd::Status => sync_cmd(&cli.dir, cli.api, Direction::Both, true)?,
        Cmd::Sync { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Both, dry_run)?,
        Cmd::Push { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Push, dry_run)?,
        Cmd::Pull { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Pull, dry_run)?,
        Cmd::Watch { interval } => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let c = &folder.config;
            let remote = Remote::new(&gh, &c.repo, &c.branch, &c.prefix);
            sync::watch(&folder, &remote, Duration::from_secs(interval.max(5)))?;
        }
        Cmd::Ls { folder: sub } => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let c = &folder.config;
            let remote = Remote::new(&gh, &c.repo, &c.branch, &c.prefix);
            let state = remote.state()?;
            let sub = sub
                .map(|s| s.trim_matches('/').to_string())
                .unwrap_or_default();
            let (mut n, mut total) = (0, 0);
            for (p, f) in &state.files {
                if !sub.is_empty() && !p.starts_with(&format!("{sub}/")) {
                    continue;
                }
                println!("{:>10}  {p}", util::human_size(f.size));
                n += 1;
                total += f.size;
            }
            println!("{n} file(s), {}", util::human_size(total));
        }
        Cmd::Log { path, limit } => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let c = &folder.config;
            let remote = Remote::new(&gh, &c.repo, &c.branch, &c.prefix);
            let p = remote.repo_path(path.as_deref().unwrap_or("").trim_matches('/'));
            let p = p.trim_end_matches('/');
            for commit in gh.history(&c.repo, &c.branch, p, limit)? {
                let first = commit.message.lines().next().unwrap_or_default();
                println!(
                    "{}  {}  {:<12} {first}",
                    &commit.sha[..7],
                    &commit.date[..10.min(commit.date.len())],
                    commit.author
                );
            }
        }
        Cmd::Restore { path, at } => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let c = &folder.config;
            let remote = Remote::new(&gh, &c.repo, &c.branch, &c.prefix);
            let path = path.trim_matches('/').to_string();
            if !nubes_core::is_safe_path(&path) {
                bail!("invalid path {path:?}");
            }
            let Some(sha) = gh.file_at(&c.repo, &remote.repo_path(&path), &at)? else {
                bail!("{path} does not exist at {at}");
            };
            if sync::local_sha(&folder, &path)?.as_deref() == Some(sha.as_str()) {
                println!("{path} already has that content");
                return Ok(());
            }
            let data = gh.blob(&c.repo, &sha)?;
            let dest = folder.root.join(&path);
            if let Some(d) = dest.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::write(&dest, data)?;
            println!("restored {path} from {at}; run `nubes sync` to make it the current version");
        }
        Cmd::Skill => print!("{SKILL}"),
        Cmd::Selftest => selftest()?,
    }
    Ok(())
}

fn sync_cmd(
    dir: &Option<PathBuf>,
    api: Option<String>,
    direction: Direction,
    dry_run: bool,
) -> Result<()> {
    let folder = Folder::find(&start_dir(dir)?)?;
    let gh = client(api)?;
    let c = &folder.config;
    let remote = Remote::new(&gh, &c.repo, &c.branch, &c.prefix);
    let out = sync::run(
        &folder,
        &remote,
        &sync::Options {
            direction,
            dry_run,
            quiet: false,
        },
    )?;
    for a in &out.plan.actions {
        println!("{}", sync::describe(a));
    }
    let s = &out.plan.summary;
    if out.plan.actions.is_empty() {
        println!("up to date");
    } else if dry_run {
        println!(
            "would upload {}, download {}, delete {} here and {} there, keep {} conflict copies",
            s.uploads, s.downloads, s.delete_local, s.delete_remote, s.conflicts
        );
    } else if let Some(c) = &out.commit {
        println!("done, commit {}", &c[..7.min(c.len())]);
    } else {
        println!("done");
    }
    Ok(())
}

fn selftest() -> Result<()> {
    let v: serde_json::Value = serde_json::from_str(VECTORS)?;
    let mut n = 0;
    for b in v["blobs"].as_array().context("blobs")? {
        let text = b["text"].as_str().unwrap_or_default();
        if nubes_core::git_blob_sha(text.as_bytes()) != b["sha"].as_str().unwrap_or_default() {
            bail!("blob vector {text:?} failed");
        }
        n += 1;
    }
    for p in v["plans"].as_array().context("plans")? {
        let input: nubes_core::PlanInput = serde_json::from_value(p["input"].clone())?;
        let out = nubes_core::plan(&input).map_err(anyhow::Error::msg)?;
        if serde_json::to_value(&out.actions)? != p["actions"]
            || serde_json::to_value(&out.next_base)? != p["nextBase"]
        {
            bail!("plan vector {:?} failed", p["name"]);
        }
        n += 1;
    }
    println!("selftest ok ({n} vectors)");
    Ok(())
}
