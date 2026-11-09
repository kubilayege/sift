//! Server-side syntax highlighting with syntect and bat's grammar collection. Tokens are reduced to
//! a handful of classes the UI colours with CSS, and cached per blob id.

use crate::engine::Tokens;
use lru::LruCache;
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use syntect::easy::HighlightLines;
use syntect::highlighting::{Color, ScopeSelectors, StyleModifier, Theme, ThemeItem, ThemeSettings};
use syntect::parsing::{SyntaxReference, SyntaxSet};

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);
static THEME: LazyLock<Theme> = LazyLock::new(build_theme);

/// Token classes; index = class id sent to the UI (`.t1` ... in CSS). 0 is plain text.
const CLASSES: &[&str] = &[
    "",
    "comment, punctuation.definition.comment, string.comment",
    "keyword, storage, storage.type, storage.modifier, keyword.control, keyword.operator.new, keyword.operator.expression, keyword.operator.word, keyword.other, variable.language",
    "string, string.template, string.quoted, markup.inline.raw, markup.raw, string.unquoted.plain",
    "constant.numeric, constant.language, constant.character, support.constant, constant.other",
    "entity.name.function, support.function, variable.function, meta.function-call.identifier",
    "entity.name.type, entity.name.class, entity.name.struct, entity.name.enum, entity.name.interface, entity.name.trait, support.class, support.type, entity.other.inherited-class, entity.name.namespace, storage.type.primitive",
    "entity.name.tag, meta.tag.sgml",
    "entity.other.attribute-name, support.type.property-name, meta.object-literal.key, meta.mapping.key, entity.name.label, variable.other.member, variable.other.property",
    "punctuation, keyword.operator, meta.brace",
    "variable.parameter",
    "markup.heading, entity.name.section",
    "markup.underline.link, string.other.link",
    "string.regexp, constant.character.escape",
    "markup.bold",
    "markup.italic",
    "markup.inserted",
    "markup.deleted",
];

fn build_theme() -> Theme {
    let scopes = CLASSES
        .iter()
        .enumerate()
        .skip(1)
        .filter_map(|(i, sel)| {
            Some(ThemeItem {
                scope: ScopeSelectors::from_str(sel).ok()?,
                style: StyleModifier { foreground: Some(Color { r: i as u8, g: 0, b: 0, a: 255 }), background: None, font_style: None },
            })
        })
        .collect();
    Theme {
        name: Some("sift".into()),
        author: None,
        settings: ThemeSettings { foreground: Some(Color { r: 0, g: 0, b: 0, a: 255 }), ..Default::default() },
        scopes,
    }
}

/// Load grammars in the background so the first highlighted file does not pay for it.
pub fn warm_up() {
    std::thread::spawn(|| {
        LazyLock::force(&SYNTAXES);
        LazyLock::force(&THEME);
    });
}

fn find(name: &str) -> Option<&'static SyntaxReference> {
    SYNTAXES.find_syntax_by_extension(name).or_else(|| SYNTAXES.find_syntax_by_token(name))
}

pub fn syntax_for(path: &str) -> Option<&'static SyntaxReference> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit_once('.').map(|x| x.1).unwrap_or("");
    let mapped: &[&str] = match ext {
        "unity" | "prefab" | "asset" | "mat" | "controller" | "anim" | "meta" | "overridecontroller" | "physicmaterial"
        | "mask" | "playable" | "lighting" | "spriteatlas" | "preset" | "signal" | "terrainlayer" | "mixer" | "brush"
        | "flare" | "giparams" | "renderTexture" | "cubemap" => &["yaml"],
        "asmdef" | "asmref" | "inputactions" | "shadergraph" | "shadersubgraph" | "jsonc" | "json5" => &["json"],
        "uss" => &["css"],
        "uxml" | "csproj" | "props" | "targets" | "plist" | "xaml" | "resx" => &["xml"],
        "shader" | "cginc" | "hlsl" | "hlslinc" | "compute" | "fx" => &["hlsl", "glsl", "c"],
        "glsl" | "vert" | "frag" | "wgsl" => &["glsl", "c"],
        "mts" | "cts" => &["ts"],
        "mjs" | "cjs" => &["js"],
        _ => &[],
    };
    let syn = mapped
        .iter()
        .find_map(|m| find(m))
        .or_else(|| find(ext))
        .or_else(|| find(name))
        .or_else(|| find(&lower))?;
    (syn.name != "Plain Text").then_some(syn)
}

const MAX_BYTES: usize = 3 << 20;
const MAX_LINES: usize = 60_000;
const MAX_LINE: usize = 6_000;
const BUDGET: Duration = Duration::from_millis(2500);

/// Tokens for every line of `text`, or None when the file is not worth highlighting (unknown
/// language, minified, huge). Lines past the time budget come back plain.
pub fn highlight(path: &str, text: &str) -> Option<Tokens> {
    if text.len() > MAX_BYTES {
        return None;
    }
    let syntax = syntax_for(path)?;
    let lines = crate::util::split_lines(text);
    if lines.len() > MAX_LINES || lines.iter().any(|l| l.len() > MAX_LINE) {
        return None;
    }
    let mut h = HighlightLines::new(syntax, &THEME);
    let started = Instant::now();
    let mut out: Tokens = Vec::with_capacity(lines.len());
    let mut buf = String::new();
    for (i, line) in lines.iter().enumerate() {
        if i % 256 == 0 && started.elapsed() > BUDGET {
            break;
        }
        buf.clear();
        buf.push_str(line);
        buf.push('\n');
        let Ok(ranges) = h.highlight_line(&buf, &SYNTAXES) else { break };
        let mut flat: Vec<u16> = Vec::new();
        for (style, piece) in ranges {
            let piece = piece.trim_end_matches(['\n', '\r']);
            if piece.is_empty() {
                continue;
            }
            let len = piece.encode_utf16().count().min(u16::MAX as usize) as u16;
            let cls = style.foreground.r as u16;
            match flat.len() {
                n if n >= 2 && flat[n - 1] == cls => flat[n - 2] = flat[n - 2].saturating_add(len),
                _ => flat.extend([len, cls]),
            }
        }
        if flat.len() == 2 && flat[1] == 0 {
            flat.clear();
        }
        out.push(flat);
    }
    out.resize(lines.len(), Vec::new());
    Some(out)
}

/// Highlighted blobs, bounded by a rough byte budget.
pub struct TokenCache {
    inner: Mutex<(LruCache<String, Arc<Option<Tokens>>>, usize)>,
    budget: usize,
}

fn weight(t: &Option<Tokens>) -> usize {
    t.as_ref().map(|t| t.iter().map(|l| l.len() * 2 + 24).sum()).unwrap_or(16)
}

impl TokenCache {
    pub fn new(budget: usize) -> TokenCache {
        TokenCache { inner: Mutex::new((LruCache::unbounded(), 0)), budget }
    }

    pub fn get_or(&self, key: &str, make: impl FnOnce() -> Option<Tokens>) -> Arc<Option<Tokens>> {
        if let Some(v) = self.inner.lock().unwrap().0.get(key) {
            return v.clone();
        }
        let v = Arc::new(make());
        let mut g = self.inner.lock().unwrap();
        g.1 += weight(&v);
        g.0.put(key.to_string(), v.clone());
        while g.1 > self.budget {
            match g.0.pop_lru() {
                Some((_, old)) => g.1 = g.1.saturating_sub(weight(&old)),
                None => break,
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages() {
        for p in ["a.ts", "b.tsx", "c.rs", "d.cs", "Assets/x.prefab", "e.py", "f.json", "g.md", "Dockerfile", "h.yaml"] {
            assert!(syntax_for(p).is_some(), "no syntax for {p}");
        }
        assert!(syntax_for("notes.unknownext").is_none());
    }

    #[test]
    fn tokens() {
        let t = highlight("a.ts", "// hi\nconst x = \"s\";\n").unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t[0], vec![5, 1]);
        assert!(t[1].chunks(2).any(|c| c[1] == 3), "string class in {:?}", t[1]);
        assert!(t[1].chunks(2).any(|c| c[1] == 2), "keyword class in {:?}", t[1]);
    }
}
