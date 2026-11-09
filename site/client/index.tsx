import { useEffect, useState } from "preact/hooks";
import { RELEASES, VERSION } from "../shared/releases";
import { PLATFORMS, REPO } from "../shared/types";
import { ProductMock } from "./mock";
import { css } from "./styles";

const FONTS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap";

function useHead() {
  useEffect(() => {
    if (!document.querySelector("link[data-fonts]")) {
      const pre = document.createElement("link");
      pre.rel = "preconnect";
      pre.href = "https://fonts.gstatic.com";
      pre.crossOrigin = "";
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = FONTS;
      l.setAttribute("data-fonts", "");
      document.head.append(pre, l);
    }
    document.title = "sift · review what your agents changed";
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      document.head.append(meta);
    }
    meta.setAttribute(
      "content",
      "A local code review desk for agent-written changes: notes pinned to lines, files ranked by importance, a guided walkthrough, and comments that go back to the agent."
    );
  }, []);
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className={`copy ${ok ? "ok" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1600);
        } catch {
          /* clipboard blocked: the command is still selectable */
        }
      }}
    >
      {ok ? "Copied" : label}
    </button>
  );
}

function InstallCmd({ origin }: { origin: string }) {
  const cmd = `curl -fsSL ${origin}/install.sh | sh`;
  return (
    <div className="cmd">
      <code>
        <span className="p">$</span>
        {cmd}
      </code>
      <Copy text={cmd} />
    </div>
  );
}

const Mark = ({ size = 20 }: { size?: number }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <path d="M6 9h20M6 16h13M6 23h7" stroke="var(--k-important)" stroke-width="3.2" stroke-linecap="round" />
  </svg>
);

const KINDS: [string, string][] = [
  ["Look here", "var(--k-important)"],
  ["Risk", "var(--k-risk)"],
  ["Question", "var(--k-question)"],
  ["Follow-up", "var(--k-todo)"],
  ["Why", "var(--k-why)"],
  ["Checked", "var(--k-verify)"],
  ["Note", "var(--k-info)"]
];

const KEYS: [string[], string][] = [
  [["←", "→"], "Previous / next stop: change, note, comment"],
  [["⇧←", "⇧→"], "Previous / next file"],
  [["t"], "Start or stop the walkthrough"],
  [["j", "k"], "Next / previous file"],
  [["[", "]"], "Previous / next change"],
  [["u"], "Next unviewed file"],
  [["v"], "Mark viewed, go to the next unviewed"],
  [["o", "O"], "Collapse this file / every file"],
  [["c"], "Comment on the current file"],
  [["s"], "Unified or split view"],
  [["w"], "Hide whitespace changes"],
  [["?"], "All shortcuts"]
];

const ORDER = Object.keys(PLATFORMS);

const fmtSize = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function guessPlatform(): string | null {
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return "sift-macos-arm64";
  if (/Linux/.test(ua) && !/Android/.test(ua)) return /aarch64|arm64/i.test(ua) ? "sift-linux-arm64" : "sift-linux-x86_64";
  return null;
}

export function App() {
  useHead();
  const origin = typeof location !== "undefined" ? location.origin : "https://sift.lakebed.app";
  const [rec, setRec] = useState<string | null>(null);
  useEffect(() => setRec(guessPlatform()), []);

  return (
    <div className="page">
      <style>{css}</style>

      <nav className="nav">
        <div className="wrap">
          <a className="brand" href="#top">
            <Mark />
            sift
          </a>
          <div className="nav-links">
            <a href="#loop">How it works</a>
            <a href="#features">Features</a>
            <a href="#keyboard">Keyboard</a>
            <a className="keep" href="#install">Install</a>
            <a className="keep" href={`https://github.com/${REPO}`}>GitHub</a>
          </div>
          <span className="nav-ver">v{VERSION}</span>
        </div>
      </nav>

      <header className="hero" id="top">
        <div className="wrap">
          <span className="eyebrow">
            <i />A local review desk for agent-written code
          </span>
          <h1>
            Review what your agents <em>changed.</em>
          </h1>
          <p className="lede">
            Agents explain their work through a small CLI: <b>notes pinned to the exact lines</b>, files <b>ranked by importance</b>,
            and a <b>numbered walkthrough</b>. You read it in a fast local browser UI and send line comments straight back to the agent.
          </p>
          <div className="install">
            <InstallCmd origin={origin} />
            <div className="install-meta">
              <span>macOS &amp; Linux · one binary · needs only git</span>
              <a href="#install">Other ways to install</a>
            </div>
          </div>
        </div>
      </header>

      <div className="stage">
        <div className="wrap">
          <ProductMock />
        </div>
      </div>

      <section id="loop">
        <div className="wrap">
          <div className="kicker">How it works</div>
          <h2>A review loop between you and the agent.</h2>
          <p className="sub">
            The agent snapshots a baseline before it edits, annotates when it is done, and picks up your comments afterwards. You never
            leave the browser tab.
          </p>
          <div className="loop">
            <div>
              <span className="who-tag agent">agent</span>
              <span className="num">1</span>
              <pre>sift begin "Stackable items"</pre>
              <p>Snapshots the working tree as the baseline. Your index and files are never touched.</p>
            </div>
            <div>
              <span className="who-tag agent">agent</span>
              <span className="num">2</span>
              <pre>sift import notes.json</pre>
              <p>The brief, file ranking, line notes and walkthrough steps, in one call. Notes anchor to code text, not line numbers.</p>
            </div>
            <div>
              <span className="who-tag you">you</span>
              <span className="num">3</span>
              <pre>sift</pre>
              <p>Opens the review in your browser. It updates live while the agent keeps working. Click a line number to comment.</p>
            </div>
            <div>
              <span className="who-tag agent">agent</span>
              <span className="num">4</span>
              <pre>
                sift feedback{"\n"}
                <span className="d">sift reply &lt;id&gt; --resolve</span>
              </pre>
              <p>Reads your comments with the code they point at, fixes things, and replies. Replies show up in your tab.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="features">
        <div className="wrap">
          <div className="kicker">What you see</div>
          <h2>The diff, with the reasoning written in the margin.</h2>
          <div className="grid">
            <div className="card wide">
              <h3>Margin notes in seven inks</h3>
              <p>
                Each note says what the reviewer should do with it: read closely, judge a risk, answer a question, track a follow-up. A bar
                marks the lines it covers, and the brief collects everything that needs your attention.
              </p>
              <div className="inks">
                {KINDS.map(([k, c]) => (
                  <span key={k} style={{ "--mk": c }}>
                    {k}
                  </span>
                ))}
              </div>
            </div>
            <div className="card">
              <h3>Files ranked, noise folded</h3>
              <div className="bands">
                <div><b>Start here</b><span>critical · high</span></div>
                <div><b>Changes</b><span>normal</span></div>
                <div><b>Low signal</b><span>tests · assets</span></div>
                <div><b>Noise</b><span>lockfiles · build</span></div>
              </div>
            </div>
            <div className="card">
              <h3>A guided walkthrough</h3>
              <p>
                The agent numbers the notes that tell the story, in reading order. Press <code>t</code>, then <code>←</code> <code>→</code>.
              </p>
            </div>
            <div className="card">
              <h3>Comments go back</h3>
              <p>
                Click a line number, shift-click to cover a range, or comment on a file or the whole change. Agents answer from the CLI.
              </p>
            </div>
            <div className="card">
              <h3>Viewed means viewed</h3>
              <p>Viewed marks are tied to the file's content, so a file un-views itself when the agent changes it again.</p>
            </div>
            <div className="card">
              <h3>Any view of the repo</h3>
              <p>An agent session, uncommitted or staged changes, your branch against the default branch, the last commit, or any revision.</p>
            </div>
            <div className="card">
              <h3>A proper diff</h3>
              <p>Unified or split, word-level emphasis, the enclosing function on hunk separators, expandable context, hide-whitespace.</p>
            </div>
            <div className="card">
              <h3>Any agent</h3>
              <p>
                Ships with a skill for Claude Code. Codex, Cursor and anything else that runs shell commands can use the CLI; <code>sift skill print</code> gives them the guide.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="speed">
        <div className="wrap">
          <div className="kicker">Built for large changes</div>
          <h2>Stays fast on huge diffs.</h2>
          <div className="speed">
            <div className="bench">
              <div className="bench-h">
                <b>5,645 files, +624k −95k lines</b> in a Unity repo · Apple Silicon, 10 cores
              </div>
              <div className="bar">
                <div className="bar-l"><code>git diff --stat</code><span>1.4 s</span></div>
                <div className="bar-t"><i style={{ width: "100%", background: "var(--ink-4)" }} /></div>
              </div>
              <div className="bar">
                <div className="bar-l"><span><code>sift changes</code><em>cold</em></span><span>0.35 s</span></div>
                <div className="bar-t"><i style={{ width: "25%", background: "var(--k-important)" }} /></div>
              </div>
              <div className="bar">
                <div className="bar-l">UI reload after an edit<span>~0.08 s</span></div>
                <div className="bar-t"><i style={{ width: "5.7%", background: "var(--add)" }} /></div>
              </div>
            </div>
            <div className="how">
              <div>
                <b>In-process diffing</b>
                <p>Histogram diff with git's indent heuristic, fed by long-lived git pipes and a worker pool.</p>
              </div>
              <div>
                <b>Content-addressed caching</b>
                <p>Stats, hunks and syntax tokens are keyed by blob id; a reload only recomputes files that changed.</p>
              </div>
              <div>
                <b>Lazy files, virtual lists</b>
                <p>Each diff loads as it nears the viewport. A multi-million-pixel review keeps about a thousand DOM nodes.</p>
              </div>
              <div>
                <b>Server-side highlighting</b>
                <p>TypeScript, C#, Rust, HLSL, Unity YAML and more, sent as compact class runs. The browser parses nothing.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="keyboard">
        <div className="wrap">
          <div className="kicker">Keyboard first</div>
          <h2>Read the whole review without touching the mouse.</h2>
          <div className="keys">
            {KEYS.map(([ks, d]) => (
              <div className="key" key={d}>
                <span className="k">
                  {ks.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
                {d}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="install">
        <div className="wrap">
          <div className="kicker">Install</div>
          <h2>One binary. Copy it anywhere and it works.</h2>
          <div className="inst">
            <div className="panel">
              <h3>Quick install</h3>
              <p>For macOS and Linux. On Windows, run it inside WSL.</p>
              <InstallCmd origin={origin} />
              <ul>
                <li>Picks the build for your OS and CPU and checks its SHA-256.</li>
                <li>Installs to <code>~/.local/bin/sift</code>. Set <code>SIFT_BIN_DIR</code> to change it.</li>
                <li>Adds the Claude Code skill if <code>~/.claude</code> exists. <code>SIFT_NO_SKILL=1</code> skips it.</li>
                <li>Running it again updates sift in place, even with a review open.</li>
              </ul>
            </div>
            <div className="panel">
              <h3>Download</h3>
              <p>
                v{VERSION} · <a href="/download/SHA256SUMS">SHA256SUMS</a> ·{" "}
                <a href={`https://github.com/${REPO}/releases`}>All releases on GitHub</a>
              </p>
              <div className="dl">
                {RELEASES.length === 0 && <p className="meta">Builds are being uploaded.</p>}
                {[...RELEASES].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name)).map((r) => {
                  const p = PLATFORMS[r.name] ?? { label: r.name, detail: "" };
                  return (
                    <a key={r.name} href={`/download/${r.name}.tar.gz`} className={rec === r.name ? "rec" : ""}>
                      <span className="pl">
                        {p.label}
                        <span>{p.detail}</span>
                        {rec === r.name && <span className="rec-tag">your system</span>}
                      </span>
                      <span className="meta">
                        {r.name}.tar.gz · {fmtSize(r.size)} · sha256 {r.sha256.slice(0, 16)}…
                      </span>
                      <span className="arrow">Download ↓</span>
                    </a>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="inst">
            <div className="panel">
              <h3>Manual install</h3>
              <ol className="steps">
                <li>
                  Unpack and put it on your PATH:
                  <pre className="block">
                    tar -xzf sift-macos-arm64.tar.gz{"\n"}mv sift ~/.local/bin/
                  </pre>
                </li>
                <li>
                  macOS only, if you downloaded it in a browser: the binary is not notarized, so clear the quarantine flag.
                  <pre className="block">xattr -d com.apple.quarantine ~/.local/bin/sift</pre>
                </li>
                <li>
                  Teach your agents the workflow:
                  <pre className="block">sift skill install</pre>
                </li>
              </ol>
              <h3 style={{ marginTop: "26px" }}>From source</h3>
              <p>
                Needs Rust, Node.js (to build the UI once) and git. <code>install.sh</code> builds both and installs the binary and the skill.
              </p>
              <pre className="block">
                git clone https://github.com/{REPO}{"\n"}cd sift && ./install.sh
              </pre>
            </div>
            <div className="panel">
              <h3>Then, in any git repository</h3>
              <pre className="block">
                <span className="c"># you: open the review (a stable port per repo)</span>
                {"\n"}sift{"\n\n"}
                <span className="c"># what is open, and where</span>
                {"\n"}sift status{"\n"}sift url
              </pre>
              <p style={{ marginTop: "14px" }}>
                Ask a Claude Code agent to <b>"use sift"</b>, and send it back with <b>"address my sift feedback"</b>. For other agents, put
                the output of <code>sift skill print</code> in the project's <code>AGENTS.md</code>. Several agents in one repo each pass{" "}
                <code>--session &lt;id&gt;</code>.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span className="brand" style={{ fontSize: "16px" }}>
            <Mark size={16} />
            sift
          </span>
          <span>v{VERSION} · MIT · runs locally, your code never leaves your machine</span>
          <a href={`https://github.com/${REPO}`}>Source on GitHub</a>
          <a className="r" href="#top">
            Back to top ↑
          </a>
        </div>
      </footer>
    </div>
  );
}
