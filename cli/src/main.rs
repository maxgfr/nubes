//! nubes: sync a folder with GitHub repositories you own.

mod config;
mod creds;
mod crypt;
mod github;
mod pool;
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

use crate::config::{parse_target, Config, Folder, PoolConfig, State, Target};
use crate::github::{status_of, GitHub, Remote};
use crate::pool::Pool;

const SKILL: &str = include_str!("../../skills/nubes/SKILL.md");
const VECTORS: &str = include_str!("../../crates/core/tests/vectors.json");
/// GitHub ignores pre-filling parameters on the new token page: list the steps.
const TOKEN_HELP: &str = "\
Create a fine-grained token: https://github.com/settings/personal-access-tokens/new
  a. give it a name (\"nubes\") and an expiration;
  b. Repository access: \"All repositories\" (nubes creates its repositories
     as they fill up), or \"Only select repositories\" to use one you pick;
  c. Permissions: \"Add permissions\", check \"Contents\" and set it to \"Read and write\";
     with \"All repositories\", also check \"Administration\", \"Read and write\";
  d. \"Generate token\", copy it and paste it below.";
/// A repository of a pool takes no new file past this size (GitHub
/// recommends staying under 5 GB).
const DEFAULT_MAX_SIZE: u64 = 5 << 30;

#[derive(Parser)]
#[command(
    name = "nubes",
    version,
    about = "Sync a folder with GitHub repositories you own.",
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
    /// Link this folder to a name (nubes creates the private repositories
    /// <name>-1, <name>-2… as they fill up), or to one repository:
    /// owner/repo or owner/repo:sub/folder.
    Init {
        target: String,
        /// Branch to sync (owner/repo only; default: the repository's default branch).
        #[arg(long)]
        branch: Option<String>,
        /// Name of this device in commit messages and conflict copies.
        #[arg(long)]
        device: Option<String>,
        /// Encrypt the files end to end with a passphrase (a new, empty folder only).
        #[arg(long)]
        encrypt: bool,
        /// With a name: size from which a repository takes no new file and
        /// the next one is created (e.g. 5G, 500M).
        #[arg(long, value_name = "SIZE")]
        max_size: Option<String>,
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
        /// Seconds between checks of the repositories (free when they did not
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
    /// List the remote files.
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

/// The folder and its remote side (members created by other devices included).
fn open<'a>(folder: &Folder, gh: &'a GitHub) -> Result<Pool<'a>> {
    let mut pool = Pool::open(gh, &folder.config, &folder.load_state()?);
    pool.discover()?;
    Ok(pool)
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
            max_size,
        } => {
            let root = start_dir(&cli.dir)?;
            std::fs::create_dir_all(&root)?;
            let device = device.unwrap_or_else(util::device_name);
            match parse_target(&target)? {
                Target::Pool { name } => {
                    if branch.is_some() {
                        bail!("--branch is for owner/repo: the repositories of a pool use their default branch");
                    }
                    let max_size = max_size.as_deref().map(util::parse_size).transpose()?;
                    let gh = client(cli.api)?;
                    init_pool(&gh, &root, &name, max_size, device, encrypt)?;
                }
                Target::Repo { repo, prefix } => {
                    if max_size.is_some() {
                        bail!("--max-size is for a name (a pool of repositories), not owner/repo");
                    }
                    let gh = client(cli.api)?;
                    init_repo(&gh, &root, &target, &repo, &prefix, branch, device, encrypt)?;
                }
            }
        }
        Cmd::Unlock => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let pool = open(&folder, &gh)?;
            let ps = pool.state(&folder.config.device, "")?;
            if !ps.encrypted() {
                println!("this folder is not encrypted");
                return Ok(());
            }
            pool.forget_key()?;
            pool.unlock(&ps)?;
            println!("unlocked; the key is kept in {}", creds::store_name());
        }
        Cmd::Lock => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let (account, prefix) = folder.config.key_id();
            if creds::remove_key(&account, &prefix)? {
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
            storage(&cli.dir, cli.api)?;
        }
        Cmd::Sync { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Both, dry_run)?,
        Cmd::Push { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Push, dry_run)?,
        Cmd::Pull { dry_run } => sync_cmd(&cli.dir, cli.api, Direction::Pull, dry_run)?,
        Cmd::Watch { interval } => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let mut pool = Pool::open(&gh, &folder.config, &folder.load_state()?);
            sync::watch(&folder, &mut pool, Duration::from_secs(interval.max(2)))?;
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
            let pool = open(&folder, &gh)?;
            let ps = pool.state(&folder.config.device, "")?;
            let sub = sub
                .map(|s| s.trim_matches('/').to_string())
                .unwrap_or_default();
            let (mut n, mut total) = (0, 0);
            for (p, f) in &ps.view.files {
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
            let pool = open(&folder, &gh)?;
            let path = path.as_deref().unwrap_or("").trim_matches('/').to_string();
            let ps = pool.state(&folder.config.device, "")?;
            // A file present now: the repository that holds it; otherwise all of them.
            let members: Vec<&Remote> = match ps.owner(&path) {
                Some(i) => vec![&pool.members[i]],
                None => pool.members.iter().collect(),
            };
            let several = pool.members.len() > 1;
            let mut all = Vec::new();
            for m in members {
                let p = if ps.view.files.contains_key(&path) {
                    m.stored_path(&path)
                } else {
                    m.repo_path(&path)
                };
                let p = p.trim_end_matches('/');
                for c in gh.history(&m.full, &m.branch, p, limit)? {
                    all.push((m.full.clone(), c));
                }
            }
            all.sort_by(|a, b| b.1.date.cmp(&a.1.date));
            all.truncate(limit);
            for (repo, commit) in all {
                let first = commit.message.lines().next().unwrap_or_default();
                let at = if several {
                    format!("  ({repo})")
                } else {
                    String::new()
                };
                println!(
                    "{}  {}  {:<12} {first}{at}",
                    &commit.sha[..7],
                    &commit.date[..10.min(commit.date.len())],
                    commit.author
                );
            }
        }
        Cmd::Restore { path, at } => {
            let folder = Folder::find(&start_dir(&cli.dir)?)?;
            let gh = client(cli.api)?;
            let pool = open(&folder, &gh)?;
            let path = path.trim_matches('/').to_string();
            if !nubes_core::is_safe_path(&path) {
                bail!("invalid path {path:?}");
            }
            let ps = pool.state(&folder.config.device, "")?;
            pool.unlock(&ps)?;
            // The commit belongs to one repository: the file's, else any of them.
            let order: Vec<usize> = match ps.owner(&path) {
                Some(i) => std::iter::once(i)
                    .chain((0..pool.members.len()).filter(|j| *j != i))
                    .collect(),
                None => (0..pool.members.len()).collect(),
            };
            let mut found = None;
            for i in order {
                match pool.members[i].version_at(&path, &at) {
                    Ok(Some(sha)) => {
                        found = Some((i, sha));
                        break;
                    }
                    Ok(None) => {}
                    Err(e) if matches!(status_of(&e), Some(404 | 422)) => {}
                    Err(e) => return Err(e),
                }
            }
            let Some((i, sha)) = found else {
                bail!("{path} does not exist at {at}");
            };
            if sync::local_sha(&folder, &path)?.as_deref() == Some(sha.as_str()) {
                println!("{path} already has that content");
                return Ok(());
            }
            let data = pool.members[i].get(&sha)?;
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

/// `nubes init <name>`: joins the pool, or creates its first repository.
fn init_pool(
    gh: &GitHub,
    root: &std::path::Path,
    name: &str,
    max_size: Option<u64>,
    device: String,
    encrypt: bool,
) -> Result<()> {
    let owner = gh.user()?;
    let mut cfg = PoolConfig {
        owner,
        name: name.to_string(),
        max_size: max_size.unwrap_or(DEFAULT_MAX_SIZE),
    };
    let mut pool = Pool::new(gh, cfg.clone());
    pool.discover()?;
    if let (Some(first), None) = (pool.members.first(), max_size) {
        // Joining: the limit chosen when the pool was created.
        let meta = first.read_meta(&first.state()?)?;
        if let Some(n) = meta.and_then(|m| m["maxSize"].as_u64()) {
            cfg.max_size = n;
            pool = Pool::new(gh, cfg.clone());
            pool.discover()?;
        }
    }
    if pool.members.is_empty() {
        pool.create(1)?;
    }
    let mut ps = pool.state(&device, "")?;
    if encrypt {
        if ps.encrypted() {
            bail!("{name} is already encrypted: run `nubes init {name}` without --encrypt");
        }
        if ps.file_count() > 0 {
            bail!("{name} already has plain files: encryption is for a new name");
        }
        eprintln!("Choose the passphrase of this folder. Every device asks for it once; without it, the files cannot be read back (nobody can reset it).");
        let pass = crypt::passphrase("Passphrase: ", true)?;
        pool.members[0].init_encryption(&pass)?;
        println!(
            "{name} is now encrypted end to end (key stored in {})",
            creds::store_name()
        );
        ps = pool.state(&device, "")?;
    }
    for _ in 0..3 {
        if !pool.ready(&ps)? {
            break;
        }
        ps = pool.state(&device, "")?;
    }
    // Asks the passphrase now (in a terminal) rather than at the first sync.
    pool.unlock(&ps)?;
    let limit = util::human_size(cfg.max_size);
    let folder = Folder::create(
        root,
        Config {
            repo: String::new(),
            branch: String::new(),
            prefix: String::new(),
            pool: Some(cfg),
            device,
        },
    )?;
    folder.save_state(&State {
        members: pool.member_states(),
        ..State::default()
    })?;
    println!(
        "linked {} to {} ({} remote file(s); a new private repository is created whenever they reach {limit}). Next: nubes status, then nubes sync",
        folder.root.display(),
        pool.describe(),
        ps.file_count(),
    );
    Ok(())
}

/// `nubes init owner/repo[:folder]`.
#[allow(clippy::too_many_arguments)]
fn init_repo(
    gh: &GitHub,
    root: &std::path::Path,
    target: &str,
    repo: &str,
    prefix: &str,
    branch: Option<String>,
    device: String,
    encrypt: bool,
) -> Result<()> {
    let info = gh.repo_info(repo)?.with_context(|| {
        format!("GitHub 404 on /repos/{repo}: no such repository, or the token cannot see it")
    })?;
    if !info.can_push || !gh.can_write(repo)? {
        bail!(
            "the token can read {repo} but not write to it: on GitHub, edit the token and set Permissions → Contents to “Read and write”"
        );
    }
    let branch = branch.unwrap_or(info.default_branch);
    let config = Config {
        repo: repo.to_string(),
        branch: branch.clone(),
        prefix: prefix.to_string(),
        pool: None,
        device,
    };
    let remote = Remote::new(gh, repo, &branch, prefix);
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
    let folder = Folder::create(root, config)?;
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
    let mut pool = Pool::open(&gh, &folder.config, &folder.load_state()?);
    let out = sync::run(
        &folder,
        &mut pool,
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
    let short = |c: &str| c[..7.min(c.len())].to_string();
    if out.plan.actions.is_empty() && out.commits.is_empty() {
        println!("up to date");
    } else if dry_run {
        println!(
            "would upload {}, download {}, delete {} here and {} there, keep {} conflict copies",
            s.uploads, s.downloads, s.delete_local, s.delete_remote, s.conflicts
        );
    } else if pool.auto.is_none() && out.commits.len() == 1 {
        println!("done, commit {}", short(&out.commits[0].1));
    } else if !out.commits.is_empty() {
        let list: Vec<String> = out
            .commits
            .iter()
            .map(|(repo, c)| format!("{} in {repo}", short(c)))
            .collect();
        println!("done, commit {}", list.join(", "));
    } else {
        println!("done");
    }
    Ok(())
}

/// Same thresholds as the web app's storage gauge: GitHub recommends a
/// repository under 1 GB, and strongly under 5 GB. A pool shows each of its
/// repositories against its limit.
fn storage(dir: &Option<PathBuf>, api: Option<String>) -> Result<()> {
    const SOFT: u64 = 1024 * 1024 * 1024;
    const HARD: u64 = 5 * SOFT;
    let folder = Folder::find(&start_dir(dir)?)?;
    let gh = client(api)?;
    // Advice only: a failed check never fails `status`.
    let Ok(pool) = open(&folder, &gh) else {
        return Ok(());
    };
    for m in &pool.members {
        let Ok(Some(info)) = gh.repo_info(&m.full) else {
            continue;
        };
        let (size, repo) = (info.size, &m.full);
        let n = util::human_size(size);
        if let Some(p) = &pool.auto {
            let state = if size >= p.max_size {
                "full: new files go to the next one"
            } else {
                "in use"
            };
            println!("{repo}: {n} of {} ({state})", util::human_size(p.max_size));
        } else if size >= HARD {
            eprintln!("! {repo} is {n}, over 5 GB: GitHub may ask you to reduce it. Move large files to another repository.");
        } else if size >= SOFT {
            eprintln!("! {repo} is {n}, over 1 GB: GitHub recommends staying under 5 GB. Consider another repository for large files such as videos.");
        }
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
