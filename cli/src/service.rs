//! `nubes service`: runs `nubes watch` for one folder from the start of the
//! session, without a terminal. A LaunchAgent on macOS, a `systemd --user`
//! unit on Linux; nothing else (no daemon of nubes' own).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::config::{Folder, DIR};

/// What a service runs.
pub struct Spec {
    /// The `nubes` binary (a stable path: Homebrew's link, not the versioned Cellar one).
    pub exe: PathBuf,
    pub folder: PathBuf,
    /// A non-default `--api`, passed as `NUBES_API_URL`.
    pub api: Option<String>,
    /// macOS only: launchd writes the output there (Linux uses the journal).
    pub log: PathBuf,
}

impl Spec {
    pub fn new(folder: &Folder, api: Option<String>) -> Result<Self> {
        Ok(Self {
            exe: stable_exe()?,
            folder: folder.root.clone(),
            api,
            log: folder.root.join(DIR).join("watch.log"),
        })
    }
}

/// A readable, unique name for the folder's service: its name plus a hash of its path.
pub fn slug(folder: &Path) -> String {
    let name: String = folder
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let name = name.trim_matches('-');
    let name = &name[..name.len().min(30)];
    let id = &nubes_core::git_blob_sha(folder.to_string_lossy().as_bytes())[..8];
    if name.is_empty() {
        id.to_string()
    } else {
        format!("{name}-{id}")
    }
}

pub fn label(folder: &Path) -> String {
    format!("io.github.maxgfr.nubes.{}", slug(folder))
}

pub fn unit_name(folder: &Path) -> String {
    format!("nubes-{}.service", slug(folder))
}

/// The running binary, through a `nubes` on PATH that resolves to it when
/// there is one: `/opt/homebrew/bin/nubes` survives `brew upgrade`, the
/// Cellar path it points to does not.
fn stable_exe() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("cannot locate the nubes binary")?;
    let real = exe.canonicalize().unwrap_or_else(|_| exe.clone());
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("nubes");
            if candidate.canonicalize().ok().as_ref() == Some(&real) {
                return Ok(candidate);
            }
        }
    }
    Ok(real)
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The LaunchAgent: started at login, restarted if it stops.
pub fn plist(label: &str, spec: &Spec) -> String {
    let api = spec
        .api
        .as_deref()
        .map(|a| {
            format!(
                "\n    <key>NUBES_API_URL</key>\n    <string>{}</string>",
                xml(a)
            )
        })
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>-C</string>
    <string>{folder}</string>
    <string>watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>{api}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        label = xml(label),
        exe = xml(&spec.exe.to_string_lossy()),
        folder = xml(&spec.folder.to_string_lossy()),
        log = xml(&spec.log.to_string_lossy()),
    )
}

/// One systemd argument, quoted (`%` and `$` are systemd specifiers).
fn sd_quote(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

/// The `systemd --user` unit: started with the session, restarted if it stops.
pub fn unit(spec: &Spec) -> String {
    let env = spec
        .api
        .as_deref()
        .map(|a| format!("Environment={}\n", sd_quote(&format!("NUBES_API_URL={a}"))))
        .unwrap_or_default();
    format!(
        "[Unit]
Description=nubes: keep {folder} in sync
Wants=network-online.target
After=network-online.target

[Service]
ExecStart={exe} -C {folder_q} watch
Restart=always
RestartSec=30
{env}
[Install]
WantedBy=default.target
",
        folder = spec.folder.display().to_string().replace('%', "%%"),
        exe = sd_quote(&spec.exe.to_string_lossy()),
        folder_q = sd_quote(&spec.folder.to_string_lossy()),
    )
}

fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set")
}

fn run(cmd: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .with_context(|| format!("running {cmd}"))?;
    if !out.status.success() {
        bail!(
            "{cmd} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Where the folder's service file goes.
pub fn path(folder: &Path) -> Result<PathBuf> {
    if cfg!(target_os = "macos") {
        Ok(home()?
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", label(folder))))
    } else if cfg!(target_os = "linux") {
        let base = match std::env::var_os("XDG_CONFIG_HOME") {
            Some(d) => PathBuf::from(d),
            None => home()?.join(".config"),
        };
        Ok(base.join("systemd/user").join(unit_name(folder)))
    } else {
        bail!("`nubes service` supports macOS (launchd) and Linux (systemd) only")
    }
}

/// The service file's contents for this platform.
pub fn contents(folder: &Path, spec: &Spec) -> String {
    if cfg!(target_os = "macos") {
        plist(&label(folder), spec)
    } else {
        unit(spec)
    }
}

fn gui_domain() -> Result<String> {
    Ok(format!("gui/{}", run("id", &["-u"])?.trim()))
}

pub fn install(folder: &Folder, spec: &Spec) -> Result<()> {
    let path = path(&folder.root)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    fs::write(&path, contents(&folder.root, spec))
        .with_context(|| format!("writing {}", path.display()))?;
    if cfg!(target_os = "macos") {
        let domain = gui_domain()?;
        let target = format!("{domain}/{}", label(&folder.root));
        // Replaces a previous version of the agent, if loaded.
        let _ = run("launchctl", &["bootout", &target]);
        run(
            "launchctl",
            &["bootstrap", &domain, &path.to_string_lossy()],
        )?;
        println!("installed {}", path.display());
        println!("log: {}", spec.log.display());
    } else {
        let unit = unit_name(&folder.root);
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "enable", &unit])?;
        run("systemctl", &["--user", "restart", &unit])?;
        println!("installed {}", path.display());
        println!("log: journalctl --user -u {unit}");
        println!("to keep it running while you are logged out: loginctl enable-linger \"$USER\"");
    }
    println!(
        "{} now stays in sync in the background, from every login",
        folder.root.display()
    );
    Ok(())
}

pub fn uninstall(folder: &Folder) -> Result<()> {
    let path = path(&folder.root)?;
    if cfg!(target_os = "macos") {
        let target = format!("{}/{}", gui_domain()?, label(&folder.root));
        let _ = run("launchctl", &["bootout", &target]);
        remove(&path)
    } else {
        let unit = unit_name(&folder.root);
        let _ = run("systemctl", &["--user", "disable", "--now", &unit]);
        remove(&path)?;
        let _ = run("systemctl", &["--user", "daemon-reload"]);
        Ok(())
    }
}

fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {
            println!("removed {}", path.display());
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            println!("no service installed for this folder");
            Ok(())
        }
        Err(e) => Err(e).with_context(|| format!("removing {}", path.display())),
    }
}

pub fn status(folder: &Folder, spec: &Spec) -> Result<()> {
    let path = path(&folder.root)?;
    if !path.exists() {
        println!(
            "no service for {} (install it with `nubes service install`)",
            folder.root.display()
        );
        return Ok(());
    }
    println!("service file: {}", path.display());
    if cfg!(target_os = "macos") {
        let target = format!("{}/{}", gui_domain()?, label(&folder.root));
        match run("launchctl", &["print", &target]) {
            Ok(out) => {
                let field = |k: &str| {
                    out.lines()
                        .map(str::trim)
                        .find_map(|l| l.strip_prefix(k).map(|v| v.trim().to_string()))
                };
                let state = field("state = ").unwrap_or_else(|| "unknown".into());
                match field("pid = ") {
                    Some(pid) => println!("state: {state} (pid {pid})"),
                    None => println!("state: {state}"),
                }
            }
            Err(_) => println!("state: not loaded (run `nubes service install` again)"),
        }
        println!("log: {}", spec.log.display());
        if let Ok(text) = fs::read_to_string(&spec.log) {
            let lines: Vec<&str> = text.lines().collect();
            for l in &lines[lines.len().saturating_sub(5)..] {
                println!("  {l}");
            }
        }
    } else {
        let unit = unit_name(&folder.root);
        let state =
            run("systemctl", &["--user", "is-active", &unit]).unwrap_or_else(|_| "inactive".into());
        println!("state: {}", state.trim());
        println!("log: journalctl --user -u {unit}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> Spec {
        Spec {
            exe: "/opt/homebrew/bin/nubes".into(),
            folder: "/Users/me/My Files & 100%".into(),
            api: None,
            log: "/Users/me/My Files & 100%/.nubes/watch.log".into(),
        }
    }

    #[test]
    fn names() {
        let s = slug(Path::new("/Users/me/My Files"));
        assert!(s.starts_with("my-files-"), "{s}");
        assert_eq!(s.len(), "my-files-".len() + 8);
        assert_ne!(s, slug(Path::new("/Users/other/My Files")));
        assert_eq!(slug(Path::new("/")).len(), 8);
    }

    #[test]
    fn launch_agent() {
        let p = plist("io.github.maxgfr.nubes.x", &spec());
        assert!(p.contains("<string>/Users/me/My Files &amp; 100%</string>"));
        assert!(p.contains("<string>watch</string>"));
        assert!(p.contains("<key>KeepAlive</key>"));
        assert!(!p.contains("NUBES_API_URL"));
        let with_api = plist(
            "x",
            &Spec {
                api: Some("http://localhost:1".into()),
                ..spec()
            },
        );
        assert!(with_api.contains("<key>NUBES_API_URL</key>"));
    }

    #[test]
    fn systemd_unit() {
        let u = unit(&spec());
        assert!(u.contains(
            "ExecStart=\"/opt/homebrew/bin/nubes\" -C \"/Users/me/My Files & 100%%\" watch"
        ));
        assert!(u.contains("Restart=always"));
        assert!(u.contains("WantedBy=default.target"));
    }
}
