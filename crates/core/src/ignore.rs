//! `.nubesignore`: a subset of `.gitignore`.
//!
//! - one pattern per line; blank lines and `#` comments are skipped;
//! - `*`, `?`, `[abc]` and `**` as in git; `*` never crosses `/`;
//! - a pattern without a `/` (other than a trailing one) matches a name at
//!   any depth; with one, it is anchored at the root of the synced folder;
//! - a trailing `/` matches directories only;
//! - `!pattern` re-includes, the last matching line wins, and nothing can be
//!   re-included inside an ignored directory (git's rule).
//!
//! A few names are always ignored, whatever the file says: see [`DEFAULTS`].

use crate::glob::Glob;

/// Ignored everywhere, before the user's patterns: nubes' own state, git's,
/// and the litter operating systems and office suites leave behind.
pub const DEFAULTS: &[&str] = &[
    ".nubes/",
    ".git/",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "~$*",
    ".~lock.*#",
];

struct Rule {
    glob: Glob,
    negate: bool,
    dir_only: bool,
}

pub struct Matcher {
    rules: Vec<Rule>,
}

impl Matcher {
    /// The default rules followed by `patterns` (lines of a `.nubesignore`).
    pub fn new<S: AsRef<str>>(patterns: &[S]) -> Result<Self, String> {
        let mut rules = Vec::new();
        for line in DEFAULTS
            .iter()
            .copied()
            .chain(patterns.iter().map(|p| p.as_ref()))
        {
            if let Some(rule) = parse(line)? {
                rules.push(rule);
            }
        }
        Ok(Self { rules })
    }

    /// Parses the text of a `.nubesignore` file.
    pub fn from_file_text(text: &str) -> Result<Self, String> {
        let lines: Vec<&str> = text.lines().collect();
        Self::new(&lines)
    }

    /// Whether the file at `path` is ignored, either itself or because one of
    /// its parent directories is.
    pub fn is_ignored(&self, path: &str) -> bool {
        let parts: Vec<&str> = path.split('/').collect();
        for i in 1..=parts.len() {
            let candidate = parts[..i].join("/");
            let is_dir = i < parts.len();
            if self.matches(&candidate, is_dir) {
                return true;
            }
        }
        false
    }

    /// Whether the directory at `path` is ignored (so a walker can skip it whole).
    pub fn is_dir_ignored(&self, path: &str) -> bool {
        let parts: Vec<&str> = path.split('/').collect();
        (1..=parts.len()).any(|i| self.matches(&parts[..i].join("/"), true))
    }

    fn matches(&self, candidate: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for r in &self.rules {
            if r.dir_only && !is_dir {
                continue;
            }
            if r.glob.is_match(candidate) {
                ignored = !r.negate;
            }
        }
        ignored
    }
}

fn parse(line: &str) -> Result<Option<Rule>, String> {
    let line = line.trim_end_matches(['\r', '\n']);
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return Ok(None);
    }
    let (negate, mut pat) = match trimmed.strip_prefix('!') {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    let dir_only = pat.ends_with('/');
    pat = pat.trim_end_matches('/');
    if pat.is_empty() {
        return Ok(None);
    }
    let anchored = pat.contains('/');
    let pat = pat.trim_start_matches('/');
    let glob = if anchored {
        pat.to_string()
    } else {
        format!("**/{pat}")
    };
    let glob = Glob::new(&glob);
    Ok(Some(Rule {
        glob,
        negate,
        dir_only,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(p: &[&str]) -> Matcher {
        Matcher::new(p).unwrap()
    }

    #[test]
    fn defaults() {
        let d = m(&[]);
        assert!(d.is_ignored(".nubes/state.json"));
        assert!(d.is_ignored("a/.DS_Store"));
        assert!(d.is_ignored(".git/config"));
        assert!(d.is_ignored("docs/~$report.docx"));
        assert!(!d.is_ignored("a/b.txt"));
        assert!(!d.is_ignored(".nubesignore"));
        // A file named like a default dir-only rule is not a directory.
        assert!(!d.is_ignored("notes/.git"));
    }

    #[test]
    fn basename_vs_anchored() {
        let x = m(&["*.log", "/build", "docs/tmp/"]);
        assert!(x.is_ignored("a.log"));
        assert!(x.is_ignored("deep/er/a.log"));
        assert!(x.is_ignored("build/out.bin"));
        assert!(!x.is_ignored("src/build/out.bin"));
        assert!(x.is_ignored("docs/tmp/x"));
        assert!(!x.is_ignored("docs/tmp"));
        assert!(!x.is_ignored("other/docs/tmp/x"));
    }

    #[test]
    fn negation() {
        let x = m(&["*.log", "!keep.log"]);
        assert!(x.is_ignored("a.log"));
        assert!(!x.is_ignored("keep.log"));
        assert!(!x.is_ignored("sub/keep.log"));
        // Cannot re-include inside an ignored directory.
        let y = m(&["cache/", "!cache/keep"]);
        assert!(y.is_ignored("cache/keep"));
    }

    #[test]
    fn directories() {
        let x = m(&["build/", "*.tmp"]);
        assert!(x.is_dir_ignored("build"));
        assert!(x.is_dir_ignored("a/build"));
        assert!(x.is_dir_ignored("a.tmp"));
        assert!(!x.is_dir_ignored("src"));
        assert!(m(&[]).is_dir_ignored(".nubes"));
    }

    #[test]
    fn comments_and_blank_lines() {
        let x = Matcher::from_file_text("# comment\n\n  *.tmp  \n").unwrap();
        assert!(x.is_ignored("a.tmp"));
        assert!(!x.is_ignored("# comment"));
    }

    #[test]
    fn star_does_not_cross_slash() {
        let x = m(&["docs/*.md"]);
        assert!(x.is_ignored("docs/a.md"));
        assert!(!x.is_ignored("docs/sub/a.md"));
        let y = m(&["docs/**/*.md"]);
        assert!(y.is_ignored("docs/sub/a.md"));
    }
}
