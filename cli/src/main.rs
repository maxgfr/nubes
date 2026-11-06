//! nubes: sync a folder with a GitHub repository you own.

mod config;
mod creds;
mod crypt;
mod github;
mod scan;
mod service;
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
/// GitHub ignores pre-filling parameters on the new token page: list the steps.
const TOKEN_HELP: &str = "\
Create a fine-grained token: https://github.com/settings/personal-access-tokens/new
  a. give it a name (\"nubes\") and an expiration;
  b. Repository access: \"Only select repositories\", then pick your nubes repository;
  c. Permissions: \"Add permissions\", check \"Contents\", set it to \"Read and write\";
  d. \"Generate token\", copy it and paste it below.";

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
        /// Encrypt the files end to end with a passphrase (a new, empty folder only).
        #[arg(long)]
        encrypt: bool,
    },
    /// Enter the passphrase of an encrypted folder; this device then keeps its key.
    Unlock,
    /// Forget the key of an encrypted folder on this device.
    Lock,
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
        /// Seconds between checks of the repository (free when it did not
        /// change). Local changes are picked up within seconds.
        #[arg(long, default_value_t = 15)]
        interval: u64,
    },
    /// Keep this folder in sync in the background, from every login
    /// (a LaunchAgent on macOS, a systemd user unit on Linux).
    Service {
        #[command(subcommand)]
        action: ServiceCmd,
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

#[derive(Subcommand)]
enum ServiceCmd {
    /// Run `nubes watch` for this folder at every login, and start it now.
    Install {
        /// Print the service file instead of installing it.
        #[arg(long)]
        print: bool,
    },
    /// Whether the service runs, and its last log lines.
    Status,
    /// Stop the service and remove it.
    Uninstall,
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
                eprintln!("{TOKEN_HELP}");
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
            encrypt,
        } => {
            let root = start_dir(&cli.dir)?;
            std::fs::create_dir_all(&root)?;
            let (repo, prefix) = parse_target(&target)?;
            let gh = client(cli.api)?;
            let (default_branch, can_push) = gh.repo(&repo)?;
            if !can_push || !gh.can_write(&repo)? {
                bail!(
                    "the token can read {repo} but not write to it: on GitHub, edit the token and set Permissions → Contents to “Read and write”"
                );
            }
            let branch = branch.unwrap_or(default_branch);
            let config = Config {
                repo: repo.clone(),
                branch: branch.clone(),
                prefix: prefix.clone(),
                device: device.unwrap_or_else(util::device_name),
            };
            let remote = Remote::new(&gh, &repo, &branch, &prefix);
            if encrypt {
                let state = remote.state()?;
                if state.encrypted {
                    bail!("{target} is already encrypted: run `nubes init {target}` without --encrypt");
                }
                if !state.files.is_empty() {
                    bail!("{target} already has plain files: encryption is for a new folder (a new repository, or {repo}:a-new-folder)");
                }
                eprintln!("Choose the passphrase of this folder. Every device asks for it once; without it, the files cannot be read back (nobody can reset it).");
                let pass = crypt::passphrase("Passphrase: ", true)?;
                remote.init_encryption(&pass)?;
                println!(
                    "{target} is now encrypted end to end (key stored in {})",
                    creds::store_name()
                );
            }
            let state = remote.state()?;
            if remote.ensure_meta(&state)? {
                println!("initialized {repo} for nubes");
            }
            // Asks the passphrase now (in a terminal) rather than at the first sync.
            remote.unlock(&state)?;
            let folder = Folder::create(&root, config)?;
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
        Cmd::Unlock => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let c = &folder.config;
            let remote = Remote::new(&gh, &c.repo, &c.branch, &c.prefix);
            let state = remote.state()?;
            if !state.encrypted {
                println!("this folder is not encrypted");
                return Ok(());
            }
            creds::remove_key(&c.repo, &c.prefix)?;
            remote.unlock(&state)?;
            println!("unlocked; the key is kept in {}", creds::store_name());
        }
        Cmd::Lock => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let c = &folder.config;
            if creds::remove_key(&c.repo, &c.prefix)? {
                println!(
                    "key removed from {}: the next sync asks for the passphrase",
                    creds::store_name()
                );
            } else {
                println!("no key stored for this folder");
            }
        }
        Cmd::Status => {
            sync_cmd(&cli.dir, cli.api.clone(), Direction::Both, true)?;
            storage_warning(&cli.dir, cli.api)?;
        }
        Cmd::Sync { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Both, dry_run)?,
        Cmd::Push { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Push, dry_run)?,
        Cmd::Pull { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Pull, dry_run)?,
        Cmd::Watch { interval } => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let c = &folder.config;
            let remote = Remote::new(&gh, &c.repo, &c.branch, &c.prefix);
            sync::watch(&folder, &remote, Duration::from_secs(interval.max(2)))?;
        }
        Cmd::Service { action } => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let spec = service::Spec::new(&folder, cli.api)?;
            match action {
                ServiceCmd::Install { print: true } => {
                    print!("{}", service::contents(&folder.root, &spec));
                }
                ServiceCmd::Install { print: false } => {
                    // The service has no terminal: the token must be stored, not typed.
                    let (_, source) = creds::token()?;
                    if matches!(source, creds::Source::Env) && creds::load()?.is_none() {
                        bail!("the service cannot see NUBES_TOKEN: run `nubes login` first to store the token");
                    }
                    service::install(&folder, &spec)?;
                }
                ServiceCmd::Status => service::status(&folder, &spec)?,
                ServiceCmd::Uninstall => service::uninstall(&folder)?,
            }
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
            let path = path.as_deref().unwrap_or("").trim_matches('/').to_string();
            let state = remote.state()?;
            let p = if state.files.contains_key(&path) {
                remote.stored_path(&path)
            } else {
                remote.repo_path(&path)
            };
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
            let state = remote.state()?;
            remote.unlock(&state)?;
            let Some(sha) = remote.version_at(&path, &at)? else {
                bail!("{path} does not exist at {at}");
            };
            if sync::local_sha(&folder, &path)?.as_deref() == Some(sha.as_str()) {
                println!("{path} already has that content");
                return Ok(());
            }
            let data = remote.get(&sha)?;
            if nubes_core::git_blob_sha(&data) != sha {
                bail!("the content of {path} does not match its id {sha}");
            }
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

/// Same thresholds as the web app's storage gauge: GitHub recommends a
/// repository under 1 GB, and strongly under 5 GB.
fn storage_warning(dir: &Option<PathBuf>, api: Option<String>) -> Result<()> {
    const SOFT: u64 = 1024 * 1024 * 1024;
    const HARD: u64 = 5 * SOFT;
    let folder = Folder::find(&start_dir(dir)?)?;
    let gh = client(api)?;
    let repo = &folder.config.repo;
    // Advice only: a failed check never fails `status`.
    let Ok(size) = gh.repo_size(repo) else {
        return Ok(());
    };
    let n = util::human_size(size);
    if size >= HARD {
        eprintln!("! {repo} is {n}, over 5 GB: GitHub may ask you to reduce it. Move large files to another repository.");
    } else if size >= SOFT {
        eprintln!("! {repo} is {n}, over 1 GB: GitHub recommends staying under 5 GB. Consider another repository for large files such as videos.");
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
    for c in v["pools"]["merge"].as_array().context("pools")? {
        let input: nubes_core::MergeInput = serde_json::from_value(c["input"].clone())?;
        if serde_json::to_value(nubes_core::merge(&input))? != c["output"] {
            bail!("pool merge vector {:?} failed", c["name"]);
        }
        n += 1;
    }
    for c in v["pools"]["place"].as_array().context("pools")? {
        let input: nubes_core::PlaceInput = serde_json::from_value(c["input"].clone())?;
        if serde_json::to_value(nubes_core::place(&input))? != c["output"] {
            bail!("pool place vector {:?} failed", c["name"]);
        }
        n += 1;
    }
    println!("selftest ok ({n} vectors)");
    Ok(())
}
