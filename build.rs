// The web UI is embedded into the binary. Rebuild when it (or the skill) changes, and warn when it
// has not been built yet so a bare `cargo build` still produces a working CLI.
fn main() {
    println!("cargo:rerun-if-changed=web/dist");
    println!("cargo:rerun-if-changed=skill/SKILL.md");
    if !std::path::Path::new("web/dist/index.html").exists() {
        println!("cargo:warning=web/dist is missing: run `npm install && npm run build` first, or the UI will not be served.");
    }
}
