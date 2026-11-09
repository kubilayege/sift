use anyhow::Result;
use regex::Regex;
use std::fs;
use std::io::Write;
use std::path::Path;

const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";

/// Short, readable ids (no 0/1/i/l/o): agents and humans type these.
pub fn short_id(len: usize) -> String {
    (0..len).map(|_| ALPHABET[fastrand::usize(..ALPHABET.len())] as char).collect()
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), short_id(4)));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Minimal glob: `**` spans directories, `*` and `?` do not, `{a,b}` alternation.
/// Patterns without `/` match basenames anywhere.
pub fn glob_to_regex(glob: &str) -> Option<Regex> {
    let mut g = glob.trim().trim_start_matches("./").to_string();
    let anchored = g.contains('/');
    if g.ends_with('/') {
        g.push_str("**");
    }
    let c: Vec<char> = g.chars().collect();
    let mut re = String::new();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '*' if c.get(i + 1) == Some(&'*') => {
                i += 1;
                if c.get(i + 1) == Some(&'/') {
                    i += 1;
                    re.push_str("(?:.*/)?");
                } else {
                    re.push_str(".*");
                }
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '{' => match c[i..].iter().position(|&x| x == '}') {
                Some(off) => {
                    let inner: String = c[i + 1..i + off].iter().collect();
                    let alts: Vec<String> = inner.split(',').map(regex::escape).collect();
                    re.push_str(&format!("(?:{})", alts.join("|")));
                    i += off;
                }
                None => re.push_str("\\{"),
            },
            ch => re.push_str(&regex::escape(&ch.to_string())),
        }
        i += 1;
    }
    let full = if anchored { format!("^{re}$") } else { format!("(?:^|/){re}$") };
    Regex::new(&full).ok()
}

pub fn rel_time(iso: &str) -> String {
    let Ok(t) = chrono::DateTime::parse_from_rfc3339(iso) else { return String::new() };
    let s = (chrono::Utc::now().timestamp() - t.timestamp()).max(0);
    match s {
        0..60 => format!("{s}s ago"),
        60..3600 => format!("{}m ago", (s as f64 / 60.0).round()),
        3600..86400 => format!("{}h ago", (s as f64 / 3600.0).round()),
        _ => format!("{}d ago", (s as f64 / 86400.0).round()),
    }
}

pub fn sha1_hex(parts: &[&[u8]]) -> String {
    let mut h = sha1_smol::Sha1::new();
    for p in parts {
        h.update(p);
        h.update(b"\0");
    }
    h.digest().to_string()
}

/// Split text into lines without terminators. A trailing newline does not start a new line.
pub fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        let m = |g: &str, p: &str| glob_to_regex(g).unwrap().is_match(p);
        assert!(m("*.lock", "a/b/yarn.lock"));
        assert!(m("src/gen/**", "src/gen/a/b.ts"));
        assert!(!m("src/gen/**", "src/other/b.ts"));
        assert!(m("**/*.{cs,ts}", "x/y/z.cs"));
        assert!(m("**/*.{cs,ts}", "z.ts"));
        assert!(!m("src/*.ts", "src/a/b.ts"));
        assert!(m("dist/", "dist/x/y.js"));
        assert!(m("a?c.txt", "q/abc.txt"));
    }

    #[test]
    fn lines() {
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\r\nb"), vec!["a", "b"]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
        assert_eq!(split_lines("\n"), vec![""]);
    }
}
