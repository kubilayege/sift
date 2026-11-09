# Sift

A local code review desk for agent-written changes, built to stay fast on huge diffs. Agents
explain their work with a small CLI. You read it in a browser UI that:

- pins their notes to the exact lines they are about;
- ranks files by importance and hides the noise;
- walks you through the change step by step;
- sends your line comments back to the agent.

Sift is one Rust binary with the web UI embedded in it.

```
agent:  sift begin "Stackable items"      → snapshot baseline
        ...edits...
        sift import notes.json            → brief, file ranking, line notes, walkthrough
you:    sift                              → opens the review in your browser (live-updating)
        click a line number, comment
agent:  sift feedback / sift reply <id> --resolve
```

## Built for large changes

Measured on a 5,645-file, +624k −95k line diff in a Unity repo (Apple Silicon, 10 cores):

| | time |
| --- | --- |
| `git diff --stat` | 1.4 s |
| `sift changes` (cold: snapshot + diff every file) | 0.35 s |
| UI reload after an edit (cached by blob id) | ~0.08 s |

How it gets there:

- **In-process diffing.** imara-diff runs the histogram algorithm with git's indent heuristic.
  Blobs come over long-lived `git cat-file --batch` pipes, and a pool of workers shares the work.
- **Content-addressed caching.** Stats, hunks and syntax tokens are keyed by blob id, so a live
  reload only recomputes files that changed. Diff responses are marked `immutable`, so the
  browser never fetches the same diff twice.
- **Lazy files.** The review payload lists files with their row counts but no hunks. Each file's
  diff is fetched when it scrolls near the viewport, and its placeholder is sized so the
  scrollbar is right from the start.
- **A virtualized UI.** The whole review is one virtual list, and so is the file sidebar. A
  multi-million-pixel diff keeps about a thousand DOM nodes on screen.
- **Server-side highlighting.** syntect runs with bat's grammar set (TypeScript, C#, Rust, HLSL,
  Unity YAML, ...). Tokens arrive as compact class runs, so the browser does no parsing.

For the reviewer, large changes come with:

- a folder tree with per-folder +/− counts, where one click marks a whole folder viewed;
- an "Unviewed" filter, and `u` to jump to the next unviewed file;
- `[` / `]` to step through changes, and `O` to collapse everything;
- a progress bar weighted by changed lines.

## What you get in the UI

- **Brief**: the agent's summary, stats, and a "Needs your attention" list built from its
  `important` / `risk` / `question` / `todo` notes.
- **Files ranked by importance**: Start here, Changes, Low signal, Noise.
  - Lockfiles, `.meta`, minified/map files and build output are noise automatically.
  - Unity serialized assets default to low.
  - Noise files start collapsed.
- **Margin notes**: each note kind has its own ink. A bar runs down the gutter beside the lines
  a note covers, and the card sits under the range.
- **Walkthrough** (`t`, then `n`/`p`): the agent's numbered steps in reading order.
- **Related code outside the change**: notes on untouched files render with an excerpt.
- **Comments**: click a line number (shift-click for a range), or comment on a file or the whole
  change. Agents reply from the CLI, and replies show up live.
- **Viewed** marks are tied to the file's blob ids, so a file un-views itself when it changes
  again.
- **Diff display**: unified or split view, word-level change emphasis, the enclosing function
  shown on hunk separators, expandable context, and a hide-whitespace toggle. Press `?` for
  keyboard shortcuts.
- **Other views**: uncommitted changes, staged changes, this branch vs the default branch, the
  last commit, or any revision or commit.

## Install

Prebuilt binaries for macOS (Apple Silicon, Intel) and Linux (x86_64, arm64, static):

```bash
curl -fsSL https://sift.lakebed.app/install.sh | sh
```

The installer picks your platform, checks the SHA-256, installs `~/.local/bin/sift`, and adds the
Claude Code skill if `~/.claude` exists. Tarballs are on the
[releases page](https://github.com/kubilayege/sift/releases). More at https://sift.lakebed.app.

### From source

Needs Rust (stable), Node.js (to build the UI once) and git.

```bash
git clone https://github.com/kubilayege/sift && cd sift
./install.sh                  # builds the UI and the binary, installs ~/.local/bin/sift + the skill
```

Or step by step:

```bash
npm install && npm run build  # UI → web/dist (embedded into the binary at compile time)
cargo build --release         # → target/release/sift, a single self-contained binary
cp target/release/sift ~/.local/bin/
sift skill install            # writes ~/.claude/skills/sift/SKILL.md (--dir for other agents)
```

The binary has no runtime dependencies besides `git`. Copy it to another machine and it works.

## Using it from any project

- **You:** run `sift` inside any git repository. It opens the review on a stable per-repo port.
  `sift url` prints the address, and `sift status` shows the session and any open comments.
- **Claude Code agents:** the skill is global, so agents in every repo know the workflow. Ask
  for it with "use sift", and send them back with "address my sift feedback".
- **Other agents** (Codex, Cursor, ...): anything that can run shell commands can use the CLI.
  Put `sift skill print` output, or a pointer to it, in the project's `AGENTS.md` or `CLAUDE.md`.
- **Several agents in one repo:** each passes `--session <id>` or sets `SIFT_SESSION`.

## How it works

- **Baselines.** `sift begin` writes the whole working tree as a tree object through a
  temporary copy of the index. That includes tracked and untracked files and honours
  `.gitignore`. Sift commits the tree and pins it at `refs/sift/sessions/<id>`.
  - Your index and files are never touched.
  - The session diff is baseline → current snapshot. It shows exactly the agent's changes, even
    across commits or a dirty starting tree.
- **Anchors.** Agents can place a note by text (`"at"` / `"to"`) instead of line numbers, so they
  never have to look the numbers up. Notes store the trimmed text of their anchor line. When code
  moves, Sift finds that line again nearby. If it can't, the note moves to the top of its file,
  marked as moved.
- **Storage.** Everything lives in `<repo>/.sift/`, which git-ignores itself:
  - session JSON;
  - append-only JSONL logs for notes and comments, safe with several agents writing at once;
  - UI state.
- **Live updates.** The server watches the repo (FSEvents/inotify) and ignores what `.gitignore`
  ignores. It reuses the working-tree snapshot until something changes, and pushes updates to
  the browser over server-sent events.

## Development

```bash
cargo test                    # unit tests + end-to-end CLI tests against temp repos
npm run typecheck
npm run dev                   # Vite dev server for the UI, proxying /api to a running `sift`
SIFT_DEBUG=1 sift changes     # phase timings (snapshot, diff-tree, stats)
```

Layout:

- `src/`: the Rust code:
  - `cli.rs`
  - `server.rs` (axum + watcher)
  - `review.rs` (sources, caching, anchors)
  - `engine.rs` (diff/hunks/emphasis)
  - `highlight.rs`
  - `git.rs`
  - `store.rs`
- `web/`: the React UI (`components/Stream.tsx` is the virtualized diff).
- `skill/SKILL.md`: the agent guide, embedded in the binary.
- `site/`: the sift.lakebed.app landing page and installer (a Lakebed capsule).
- `scripts/release.sh`: builds the release tarballs for every platform.

## Releasing

```bash
scripts/release.sh            # macOS arm64/x86_64 natively, static Linux arm64/x86_64 in Docker
site/publish.sh               # GitHub release v<version>, then redeploys the site with new checksums
```

## License

MIT
