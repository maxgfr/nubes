//! A small glob matcher for ignore rules, so the engine does not pull a
//! regex engine into the WebAssembly build.
//!
//! Patterns are matched segment by segment (`/`-separated):
//! - `**` as a whole segment matches zero or more segments;
//! - `*` matches any run of characters within a segment, `?` one character;
//! - `[abc]`, `[a-z]`, `[!abc]` (or `[^abc]`) match one character of a set;
//! - `\x` matches `x` literally. An unclosed `[` is a literal `[`.

#[derive(Debug, Clone)]
enum Tok {
    Lit(char),
    Any,
    Star,
    Class {
        negated: bool,
        items: Vec<(char, char)>,
    },
}

#[derive(Debug, Clone)]
enum Seg {
    DoubleStar,
    Toks(Vec<Tok>),
}

#[derive(Debug, Clone)]
pub struct Glob {
    segs: Vec<Seg>,
}

impl Glob {
    pub fn new(pattern: &str) -> Self {
        let segs = pattern
            .split('/')
            .map(|s| {
                if s == "**" {
                    Seg::DoubleStar
                } else {
                    Seg::Toks(tokenize(s))
                }
            })
            .collect();
        Self { segs }
    }

    pub fn is_match(&self, path: &str) -> bool {
        let parts: Vec<&str> = path.split('/').collect();
        match_segs(&self.segs, &parts)
    }
}

fn tokenize(s: &str) -> Vec<Tok> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() => {
                out.push(Tok::Lit(chars[i + 1]));
                i += 2;
                continue;
            }
            '*' => {
                // `**` inside a segment is just `*`.
                if !matches!(out.last(), Some(Tok::Star)) {
                    out.push(Tok::Star);
                }
            }
            '?' => out.push(Tok::Any),
            '[' => {
                if let Some((tok, next)) = class(&chars, i) {
                    out.push(tok);
                    i = next;
                    continue;
                }
                out.push(Tok::Lit('['));
            }
            _ => out.push(Tok::Lit(c)),
        }
        i += 1;
    }
    out
}

/// Parses a `[...]` class starting at `start`; returns it and the index after `]`.
fn class(chars: &[char], start: usize) -> Option<(Tok, usize)> {
    let mut i = start + 1;
    let negated = matches!(chars.get(i), Some('!') | Some('^'));
    if negated {
        i += 1;
    }
    let mut items = Vec::new();
    let mut first = true;
    while i < chars.len() {
        let c = chars[i];
        if c == ']' && !first {
            return Some((Tok::Class { negated, items }, i + 1));
        }
        first = false;
        if i + 2 < chars.len() && chars[i + 1] == '-' && chars[i + 2] != ']' {
            items.push((c, chars[i + 2]));
            i += 3;
        } else {
            items.push((c, c));
            i += 1;
        }
    }
    None
}

fn match_segs(pat: &[Seg], parts: &[&str]) -> bool {
    match pat.first() {
        None => parts.is_empty(),
        Some(Seg::DoubleStar) => (0..=parts.len()).any(|k| match_segs(&pat[1..], &parts[k..])),
        Some(Seg::Toks(toks)) => match parts.first() {
            Some(part) => {
                let chars: Vec<char> = part.chars().collect();
                match_toks(toks, &chars) && match_segs(&pat[1..], &parts[1..])
            }
            None => false,
        },
    }
}

/// Wildcard matching within one segment, with backtracking on the last `*`.
fn match_toks(toks: &[Tok], text: &[char]) -> bool {
    let (mut t, mut s) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while s < text.len() {
        match toks.get(t) {
            Some(Tok::Star) => {
                star = Some((t, s));
                t += 1;
                continue;
            }
            Some(tok) if one(tok, text[s]) => {
                t += 1;
                s += 1;
                continue;
            }
            _ => {}
        }
        match star {
            Some((st, ss)) => {
                t = st + 1;
                s = ss + 1;
                star = Some((st, ss + 1));
            }
            None => return false,
        }
    }
    toks[t..].iter().all(|tok| matches!(tok, Tok::Star))
}

fn one(tok: &Tok, c: char) -> bool {
    match tok {
        Tok::Lit(l) => *l == c,
        Tok::Any => true,
        Tok::Star => false,
        Tok::Class { negated, items } => items.iter().any(|(a, b)| *a <= c && c <= *b) != *negated,
    }
}

#[cfg(test)]
mod tests {
    use super::Glob;

    fn m(p: &str, s: &str) -> bool {
        Glob::new(p).is_match(s)
    }

    #[test]
    fn wildcards() {
        assert!(m("*.log", "a.log"));
        assert!(m("*.log", ".log"));
        assert!(!m("*.log", "a.log.txt"));
        assert!(m("a?c", "abc"));
        assert!(!m("a?c", "ac"));
        assert!(m("*a*b*", "xxaxxbxx"));
        assert!(!m("*a*b*", "xxbxxaxx"));
        assert!(m("~$*", "~$doc.docx"));
        assert!(m(".~lock.*#", ".~lock.report.odt#"));
        assert!(!m("*", "a/b"));
    }

    #[test]
    fn classes() {
        assert!(m("[abc].txt", "b.txt"));
        assert!(!m("[abc].txt", "d.txt"));
        assert!(m("[a-c]x", "bx"));
        assert!(m("[!a-c]x", "dx"));
        assert!(!m("[^a-c]x", "ax"));
        assert!(m("[]]", "]"));
        assert!(m("a[", "a["));
        assert!(m("\\*", "*"));
        assert!(!m("\\*", "a"));
    }

    #[test]
    fn double_star() {
        assert!(m("**/x", "x"));
        assert!(m("**/x", "a/b/x"));
        assert!(m("a/**", "a/b/c"));
        assert!(m("a/**/z", "a/z"));
        assert!(m("a/**/z", "a/b/c/z"));
        assert!(!m("a/**/z", "b/z"));
        assert!(m("a/**b", "a/xb"));
    }
}
