//! Small helpers: time formatting without a date crate, sizes, device name.

use std::time::{SystemTime, UNIX_EPOCH};

/// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn parts(secs: u64) -> (i64, u32, u32, u64, u64, u64) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil(days);
    (y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn now_rfc3339() -> String {
    let (y, m, d, h, mi, s) = parts(now_secs());
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `YYYYMMDD-HHMM` (UTC), for conflict copy names.
pub fn stamp(secs: u64) -> String {
    let (y, m, d, h, mi, _) = parts(secs);
    format!("{y:04}{m:02}{d:02}-{h:02}{mi:02}")
}

pub fn human_size(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

/// Parses `5G`, `500M`, `1.5GB`, `2048K` or a number of bytes (units of 1024).
pub fn parse_size(s: &str) -> anyhow::Result<u64> {
    let t = s.trim().to_ascii_uppercase();
    let t = t.strip_suffix('B').unwrap_or(&t);
    let (num, mul) = match t.chars().last() {
        Some('K') => (&t[..t.len() - 1], 1u64 << 10),
        Some('M') => (&t[..t.len() - 1], 1 << 20),
        Some('G') => (&t[..t.len() - 1], 1 << 30),
        Some('T') => (&t[..t.len() - 1], 1 << 40),
        _ => (t, 1),
    };
    match num.trim().parse::<f64>() {
        Ok(v) if v.is_finite() && v > 0.0 => Ok((v * mul as f64) as u64),
        _ => anyhow::bail!("invalid size {s:?} (examples: 5G, 500M)"),
    }
}

/// A short name for this machine, used in conflict copies and commit messages.
pub fn device_name() -> String {
    if let Ok(name) = std::env::var("NUBES_DEVICE") {
        return name;
    }
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil")
        .args(["--get", "LocalHostName"])
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !s.is_empty() {
            return s;
        }
    }
    if let Ok(s) = std::fs::read_to_string("/etc/hostname") {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    if let Ok(out) = std::process::Command::new("hostname").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s.split('.').next().unwrap_or(&s).to_string();
        }
    }
    "device".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(stamp(0), "19700101-0000");
        // 2026-11-05T10:12:00Z
        assert_eq!(stamp(1_793_873_520), "20261105-1012");
        let (y, m, d, ..) = parts(951_782_400);
        assert_eq!((y, m, d), (2000, 2, 29));
    }

    #[test]
    fn sizes() {
        assert_eq!(human_size(12), "12 B");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(parse_size("5G").unwrap(), 5 << 30);
        assert_eq!(parse_size("1.5gb").unwrap(), 3 << 29);
        assert_eq!(parse_size("2048").unwrap(), 2048);
        assert_eq!(parse_size("10K").unwrap(), 10240);
        assert!(parse_size("big").is_err());
        assert!(parse_size("0").is_err());
    }
}
