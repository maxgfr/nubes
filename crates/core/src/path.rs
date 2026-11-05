//! Path rules shared by both clients.
//!
//! A nubes path is relative, `/`-separated, and has no empty, `.` or `..`
//! component. Anything else coming from the remote tree or a dropped folder
//! is refused, so a hostile tree cannot write outside the synced folder.

/// Whether `p` is a path nubes will read or write.
pub fn is_safe_path(p: &str) -> bool {
    if p.is_empty() || p.len() > 4096 || p.starts_with('/') || p.ends_with('/') {
        return false;
    }
    if p.contains('\\') || p.contains('\0') {
        return false;
    }
    p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

/// The name a locally edited file takes when the remote copy changed too:
/// `dir/report.pdf` becomes `dir/report.conflict-<device>-<stamp>.pdf`, with
/// `-2`, `-3`… appended to the stamp if `taken` says the name is in use.
///
/// `stamp` is supplied by the caller (`YYYYMMDD-HHMM`) to keep this pure.
pub fn conflict_name(
    path: &str,
    device: &str,
    stamp: &str,
    taken: &dyn Fn(&str) -> bool,
) -> String {
    let (dir, base) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    // The extension is what follows the last dot, unless the name is only a
    // dotfile (`.env` has no extension).
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (&base[..i], &base[i..]),
        _ => (base, ""),
    };
    let device = sanitize_device(device);
    let mut n = 1u32;
    loop {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = format!("{dir}{stem}.conflict-{device}-{stamp}{suffix}{ext}");
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Device names go into file names: keep `[A-Za-z0-9_-]`, at most 32 chars.
pub fn sanitize_device(device: &str) -> String {
    let s: String = device
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(32)
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "device".into()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_paths() {
        for ok in ["a", "a/b.txt", ".env", "dir/.hidden/x", "é/ü"] {
            assert!(is_safe_path(ok), "{ok}");
        }
        for bad in [
            "", "/a", "a/", "a//b", "./a", "a/../b", "..", "a\\b", "a\0b",
        ] {
            assert!(!is_safe_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn conflict_names() {
        let none = |_: &str| false;
        assert_eq!(
            conflict_name("docs/report.pdf", "mac", "20261105-1012", &none),
            "docs/report.conflict-mac-20261105-1012.pdf"
        );
        assert_eq!(
            conflict_name(".env", "mac", "20261105-1012", &none),
            ".env.conflict-mac-20261105-1012"
        );
        assert_eq!(
            conflict_name("Makefile", "Max's MacBook", "20261105-1012", &none),
            "Makefile.conflict-Max-s-MacBook-20261105-1012"
        );
        let first = "a.conflict-mac-20261105-1012.txt";
        assert_eq!(
            conflict_name("a.txt", "mac", "20261105-1012", &|p| p == first),
            "a.conflict-mac-20261105-1012-2.txt"
        );
    }
}
