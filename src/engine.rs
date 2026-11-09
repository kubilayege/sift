//! The diff engine: line diffs with imara-diff (histogram + git's indent heuristic), grouped into
//! hunks with context, intra-line emphasis, and enclosing-scope headers. Computed in-process so a
//! review of thousands of files fans out across every core.

use imara_diff::{Algorithm, Diff, InternedInput};
use serde::Serialize;
use std::ops::Range;

pub const CONTEXT: u32 = 3;
/// Files bigger than this are not diffed line by line (generated dumps, data files).
pub const MAX_DIFF_BYTES: usize = 24 << 20;

#[derive(Debug, Clone)]
pub struct Change {
    pub before: Range<u32>,
    pub after: Range<u32>,
}

pub fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(8000)].contains(&0)
}

/// Line-level edit script between two files.
pub fn changes(old: &[&str], new: &[&str], ignore_ws: bool) -> Vec<Change> {
    let collect = |d: &Diff| d.hunks().map(|h| Change { before: h.before, after: h.after }).collect();
    if ignore_ws {
        let norm = |l: &&str| l.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        let a: Vec<String> = old.iter().map(norm).collect();
        let b: Vec<String> = new.iter().map(norm).collect();
        let mut input: InternedInput<&str> = InternedInput::default();
        input.update_before(a.iter().map(String::as_str));
        input.update_after(b.iter().map(String::as_str));
        let mut d = Diff::compute(Algorithm::Histogram, &input);
        d.postprocess_lines(&input);
        collect(&d)
    } else {
        let mut input: InternedInput<&str> = InternedInput::default();
        input.update_before(old.iter().copied());
        input.update_after(new.iter().copied());
        let mut d = Diff::compute(Algorithm::Histogram, &input);
        d.postprocess_lines(&input);
        collect(&d)
    }
}

/// A hunk before its lines are materialised: half-open ranges (0-based) including context.
#[derive(Debug, Clone)]
pub struct HunkPlan {
    pub b: Range<u32>,
    pub a: Range<u32>,
    pub changes: Vec<Change>,
}

pub fn plan(changes: Vec<Change>, old_len: u32, ctx: u32) -> Vec<HunkPlan> {
    let mut plans: Vec<HunkPlan> = Vec::new();
    for c in changes {
        if let Some(last) = plans.last_mut() {
            let prev = last.changes.last().unwrap();
            if c.before.start - prev.before.end <= 2 * ctx {
                last.changes.push(c);
                continue;
            }
        }
        plans.push(HunkPlan { b: 0..0, a: 0..0, changes: vec![c] });
    }
    let n = plans.len();
    for i in 0..n {
        let prev_end = if i == 0 { 0 } else { plans[i - 1].changes.last().unwrap().before.end };
        let next_start = if i + 1 < n { plans[i + 1].changes[0].before.start } else { old_len };
        let p = &mut plans[i];
        let first = &p.changes[0];
        let last = p.changes.last().unwrap();
        let lead = ctx.min(first.before.start - prev_end);
        let trail = ctx.min(next_start.saturating_sub(last.before.end));
        p.b = first.before.start - lead..last.before.end + trail;
        p.a = first.after.start - lead..last.after.end + trail;
    }
    plans
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Stats {
    pub additions: u32,
    pub deletions: u32,
    pub rows: u32,
    pub hunks: u32,
    pub old_lines: u32,
    pub new_lines: u32,
    pub binary: bool,
    pub too_large: bool,
}

pub fn stats(old: Option<&[u8]>, new: Option<&[u8]>, ignore_ws: bool) -> Stats {
    let (o, n) = (old.unwrap_or_default(), new.unwrap_or_default());
    if is_binary(o) || is_binary(n) {
        return Stats { binary: true, ..Default::default() };
    }
    let os = String::from_utf8_lossy(o);
    let ns = String::from_utf8_lossy(n);
    let ol = crate::util::split_lines(&os);
    let nl = crate::util::split_lines(&ns);
    let mut s = Stats { old_lines: ol.len() as u32, new_lines: nl.len() as u32, ..Default::default() };
    if o.len() > MAX_DIFF_BYTES || n.len() > MAX_DIFF_BYTES {
        s.too_large = true;
        s.additions = s.new_lines;
        s.deletions = s.old_lines;
        return s;
    }
    let plans = plan(changes(&ol, &nl, ignore_ws), ol.len() as u32, CONTEXT);
    for p in &plans {
        let adds: u32 = p.changes.iter().map(|c| c.after.len() as u32).sum();
        s.additions += adds;
        s.deletions += p.changes.iter().map(|c| c.before.len() as u32).sum::<u32>();
        s.rows += p.b.len() as u32 + adds;
    }
    s.hunks = plans.len() as u32;
    s
}

// ---- rendering ----------------------------------------------------------------------------

#[derive(Serialize, Debug)]
pub struct LineOut {
    pub t: &'static str,
    pub s: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub o: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
    /// Changed span within the line (UTF-16 offsets), for intra-line emphasis.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub e: Option<[u32; 2]>,
    /// Syntax tokens: flat [utf16_len, class, utf16_len, class, ...].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub k: Option<Vec<u16>>,
}

#[derive(Serialize, Debug)]
pub struct HunkOut {
    /// First old / new line covered (1-based) and how many lines of each side the hunk spans.
    pub os: u32,
    pub ns: u32,
    pub ol: u32,
    pub nl: u32,
    pub header: String,
    pub lines: Vec<LineOut>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffOut {
    pub hunks: Vec<HunkOut>,
    pub old_lines: u32,
    pub new_lines: u32,
    pub binary: bool,
    pub too_large: bool,
}

pub type Tokens = Vec<Vec<u16>>;

pub struct Side<'a> {
    pub lines: Vec<&'a str>,
    pub toks: Option<&'a Tokens>,
}

impl Side<'_> {
    fn tok(&self, idx: u32) -> Option<Vec<u16>> {
        self.toks.and_then(|t| t.get(idx as usize)).filter(|v| !v.is_empty()).cloned()
    }
}

pub fn render(old: &Side, new: &Side, ignore_ws: bool) -> DiffOut {
    let plans = plan(changes(&old.lines, &new.lines, ignore_ws), old.lines.len() as u32, CONTEXT);
    let mut hunks = Vec::with_capacity(plans.len());
    for p in plans {
        let mut lines = Vec::with_capacity((p.b.len() + p.a.len()) as usize);
        let (mut i, mut j) = (p.b.start, p.a.start);
        let ctx_line = |i: u32, j: u32| LineOut {
            t: " ",
            s: new.lines[j as usize].to_string(),
            o: Some(i + 1),
            n: Some(j + 1),
            e: None,
            k: new.tok(j),
        };
        for c in &p.changes {
            while i < c.before.start {
                lines.push(ctx_line(i, j));
                i += 1;
                j += 1;
            }
            let dels: Vec<u32> = c.before.clone().collect();
            let adds: Vec<u32> = c.after.clone().collect();
            let emph = pair_emphasis(&dels, &adds, &old.lines, &new.lines);
            for (x, &d) in dels.iter().enumerate() {
                lines.push(LineOut { t: "-", s: old.lines[d as usize].to_string(), o: Some(d + 1), n: None, e: emph.0[x], k: old.tok(d) });
            }
            for (y, &a) in adds.iter().enumerate() {
                lines.push(LineOut { t: "+", s: new.lines[a as usize].to_string(), o: None, n: Some(a + 1), e: emph.1[y], k: new.tok(a) });
            }
            i = c.before.end;
            j = c.after.end;
        }
        while i < p.b.end {
            lines.push(ctx_line(i, j));
            i += 1;
            j += 1;
        }
        let first = &p.changes[0];
        let header = if !new.lines.is_empty() {
            scope_header(&new.lines, first.after.start as usize, p.a.start as usize)
        } else {
            scope_header(&old.lines, first.before.start as usize, p.b.start as usize)
        };
        hunks.push(HunkOut { os: p.b.start + 1, ns: p.a.start + 1, ol: p.b.len() as u32, nl: p.a.len() as u32, header, lines });
    }
    DiffOut { hunks, old_lines: old.lines.len() as u32, new_lines: new.lines.len() as u32, binary: false, too_large: false }
}

type Emph = Option<[u32; 2]>;

/// Greedy, order-preserving pairing: each removed line pairs with the next added line that is
/// recognisably the same line edited, looking a few lines ahead.
fn pair_emphasis(dels: &[u32], adds: &[u32], old: &[&str], new: &[&str]) -> (Vec<Emph>, Vec<Emph>) {
    let mut de = vec![None; dels.len()];
    let mut ae = vec![None; adds.len()];
    if dels.is_empty() || adds.is_empty() || dels.len() * adds.len() > 250_000 {
        return (de, ae);
    }
    let add16: Vec<Vec<u16>> = adds.iter().map(|&a| new[a as usize].encode_utf16().collect()).collect();
    let mut next = 0;
    for (x, &d) in dels.iter().enumerate() {
        let a16: Vec<u16> = old[d as usize].encode_utf16().collect();
        for y in next..adds.len().min(next + 8) {
            if let Some((ra, rb)) = changed_range(&a16, &add16[y]) {
                if ra.1 > ra.0 {
                    de[x] = Some([ra.0, ra.1]);
                }
                if rb.1 > rb.0 {
                    ae[y] = Some([rb.0, rb.1]);
                }
                next = y + 1;
                break;
            }
        }
    }
    (de, ae)
}

fn is_sp(c: u16) -> bool {
    c == b' ' as u16 || c == b'\t' as u16
}

/// Span that differs between two versions of a line, or None when they are not really "the
/// same line, edited" (emphasis there would be noise).
pub fn changed_range(a: &[u16], b: &[u16]) -> Option<((u32, u32), (u32, u32))> {
    let max = a.len().min(b.len());
    let mut p = 0;
    while p < max && a[p] == b[p] {
        p += 1;
    }
    let mut s = 0;
    while s < max - p && a[a.len() - 1 - s] == b[b.len() - 1 - s] {
        s += 1;
    }
    let lead = |x: &[u16]| x.iter().take_while(|&&c| is_sp(c)).count();
    let trail = |x: &[u16]| x.iter().rev().take_while(|&&c| is_sp(c)).count();
    let indent = p.min(lead(a)).min(lead(b));
    let shared = p - indent + s.saturating_sub(1);
    let body = |x: &[u16]| x.len().saturating_sub(lead(x) + trail(x));
    let body = body(a).min(body(b));
    if shared < 4 || (shared as f64) < body as f64 * 0.4 {
        return None;
    }
    Some(((p as u32, (a.len() - s) as u32), (p as u32, (b.len() - s) as u32)))
}

fn indent_of(l: &str) -> usize {
    l.chars().take_while(|c| *c == ' ' || *c == '\t').map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

const CONTROL: &[&str] = &[
    "if", "else", "elif", "for", "foreach", "while", "switch", "case", "default", "return", "try", "catch", "finally",
    "do", "break", "continue", "using", "await", "yield", "throw", "match", "loop", "with", "when", "end",
];

/// The declaration enclosing a hunk: the nearest line above with less indentation that looks like
/// a definition (function, class, block opener) rather than a statement or control flow.
fn scope_header(lines: &[&str], first_changed: usize, hunk_start: usize) -> String {
    let target = lines
        .iter()
        .skip(first_changed)
        .take(20)
        .find(|l| !l.trim().is_empty())
        .map(|l| indent_of(l))
        .unwrap_or(usize::MAX);
    let mut limit = target.max(1);
    let start = hunk_start.min(lines.len());
    for i in (start.saturating_sub(4000)..start).rev() {
        let l = lines[i];
        let t = l.trim();
        if t.is_empty() {
            continue;
        }
        let ind = indent_of(l);
        if ind >= limit {
            continue;
        }
        let first = t.chars().next().unwrap();
        if !(first.is_alphabetic() || first == '_' || first == '$') {
            continue;
        }
        if t.ends_with(';') || t.ends_with(',') {
            continue;
        }
        let word: String = t.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if CONTROL.contains(&word.as_str()) {
            limit = ind;
            continue;
        }
        let mut s: String = t.chars().take(140).collect();
        if s.len() < t.len() {
            s.push('…');
        }
        return s;
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<&str> {
        crate::util::split_lines(s)
    }

    #[test]
    fn hunks_and_stats() {
        let old: String = (1..=40).map(|i| format!("line {i}\n")).collect();
        let new = old.replace("line 5\n", "line five\n").replace("line 30\n", "").replace("line 31\n", "line 31\nextra\n");
        let s = stats(Some(old.as_bytes()), Some(new.as_bytes()), false);
        assert_eq!((s.additions, s.deletions, s.hunks), (2, 2, 2));
        let (o, n) = (lines(&old), lines(&new));
        let out = render(&Side { lines: o, toks: None }, &Side { lines: n, toks: None }, false);
        assert_eq!(out.hunks.len(), 2);
        let h = &out.hunks[0];
        assert_eq!((h.os, h.ns), (2, 2));
        assert_eq!(h.lines.iter().filter(|l| l.t == " ").count(), 6);
        assert_eq!(s.rows as usize, out.hunks.iter().map(|h| h.lines.len()).sum::<usize>());
        let del = h.lines.iter().find(|l| l.t == "-").unwrap();
        assert_eq!(del.o, Some(5));
    }

    #[test]
    fn added_and_deleted_files() {
        let s = stats(None, Some(b"a\nb\n"), false);
        assert_eq!((s.additions, s.deletions, s.hunks, s.rows), (2, 0, 1, 2));
        let s = stats(Some(b"a\nb\nc"), None, false);
        assert_eq!((s.additions, s.deletions), (0, 3));
        assert!(stats(Some(b"a\0b"), Some(b"c"), false).binary);
    }

    #[test]
    fn whitespace_mode() {
        let a = "fn x() {\n  let a = 1;\n}\n";
        let b = "fn x() {\n    let a  = 1;\n}\n";
        assert_eq!(stats(Some(a.as_bytes()), Some(b.as_bytes()), true).additions, 0);
        assert_eq!(stats(Some(a.as_bytes()), Some(b.as_bytes()), false).additions, 1);
    }

    #[test]
    fn emphasis() {
        let e = |a: &str, b: &str| {
            changed_range(&a.encode_utf16().collect::<Vec<_>>(), &b.encode_utf16().collect::<Vec<_>>())
        };
        assert_eq!(e("    const total = price * qty;", "    const total = price * quantity;"), Some(((27, 27), (27, 32))));
        assert_eq!(e("    return a;", "    foo(bar);"), None);
    }

    #[test]
    fn headers() {
        let src = "class Shop {\n  buy(item) {\n    const a = 1;\n    const b = 2;\n    if (a) {\n      x();\n      y();\n      z();\n    }\n  }\n}\n";
        let l = lines(src);
        assert_eq!(scope_header(&l, 6, 5), "buy(item) {");
    }
}
