---
name: sift
description: Annotate finished code changes for the human reviewer in Sift (brief, file ranking, line notes, walkthrough) and answer their review comments. Load this when your edits are done and you are about to annotate, or when the user mentions Sift, review comments or "sift feedback". Starting a session needs no skill, just `sift begin "<task>" --agent <name>` before editing. All Sift text is written in English.
---

# Sift: show the reviewer what matters

Sift is a review UI the user keeps open beside you. It diffs the working tree against the baseline
from `sift begin` and lays your annotations over the code. Your job is to make the review fast:
point at what deserves attention, explain non-obvious choices, and get the noise out of the way.

## Rules that keep it cheap

- **English only.** Summary, titles, bodies and replies are in English, whatever language the user
  speaks to you. Your chat reply to the user stays in their language.
- **One `sift import` call** carries everything. Do not look up line numbers first: anchor notes
  with `at` (text on the first line) and `to` (text on the last line), copied from code you wrote.
- **Do not run `sift notes` afterwards.** Import prints one line, plus a warning for every anchor it
  could not resolve. If there are warnings, fix those notes and re-import them; a note with the
  same file and title replaces the earlier one.
- **`sift changes` only when you do not already know the file list**, e.g. when a generator,
  builder or formatter touched files you did not edit by hand.
- **Short handoff.** The brief carries the detail. In chat, give the user a few lines covering the
  outcome, what they must decide, and `sift` to open the review. Do not restate the brief.

## Annotate

```bash
sift import - <<'EOF'
{
  "summary": "2-6 bullets of markdown: behaviour changes first, then what the reviewer must decide.",
  "files": {
    "src/inventory.ts": { "importance": "high", "summary": "Stacking rules for add/remove" },
    "src/inventory.test.ts": "low"
  },
  "noise": ["src/generated/**"],
  "notes": [
    { "file": "src/inventory.ts", "at": "add(item: Item)", "to": "return overflow;", "kind": "important", "step": 1,
      "title": "add() now returns the overflow instead of a boolean",
      "body": "Callers doing `if (!inv.add(x))` now invert. None found in this repo." },
    { "file": "src/inventory.ts", "at": "drainNewestFirst", "kind": "question", "step": 2,
      "title": "Drain newest or oldest stack first?", "body": "Chose newest; say if design wants FIFO." },
    { "kind": "todo", "title": "Save migration v1 -> v2 not written yet" }
  ]
}
EOF
```

- `at` / `to` match a substring of one line in the file as it is now (first non-empty line of the
  text, trimmed). Pick distinctive text, such as a signature or a unique statement. If `at` occurs
  more than once, Sift takes the first and warns; add `"line": N` as a hint to choose the nearest.
  `"line"` / `"endLine"` still work when you already know the numbers.
- `"side": "old"` anchors on code you deleted (text and lines then refer to the baseline).
- The range is what the note is about: the card renders under its last line, and a bar marks the
  whole range. A note without `file` is about the whole change.
- A note on a file you did not change shows under "Related code outside this change" with an
  excerpt. Use it to show the existing code that explains your change.
- `"files"` values: an object, or just the importance as a string. Lockfiles, `.meta`, minified/map
  files and build output are noise automatically, and Unity serialized assets default to low.
- Single notes: `sift note <file> --at "<text>" [--to "<text>"] --kind K --title "..." --body "..."`.
  Fix with `sift edit <id>` / `sift rm <id>`.

### Kinds: pick the one that tells the reviewer what to do

| kind | means | the reviewer should |
| --- | --- | --- |
| `important` | behaviour, API or data-shape change a careful reviewer must not miss | read it closely |
| `risk` | might break something, a guess, or not fully checked | judge it |
| `question` | a decision you could not make yourself | answer it |
| `todo` | deliberately left undone | track it |
| `why` | reasoning behind a choice that would otherwise look odd | understand it |
| `verify` | how you checked it. Only for things you actually ran | trust it |
| `info` | context: where a value comes from, related code | skim it |

Importance per file: `critical` (must review before merging) · `high` (heart of the change) ·
`normal` (default) · `low` (tests, small follow-on edits) · `noise` (generated, renames, formatting).

### Budget

- **Notes:** 3-8 for a typical change and at most about 12 for a large one. Do not narrate hunks;
  the diff shows *what*. Notes say *why*, *watch out* and *decide*.
- **Title = the claim**, readable on its own in the "Needs your attention" list ("Cache is never
  invalidated on logout", not "Cache change"). Keep it under about 80 characters.
- **Body = the evidence**, at most 1-3 sentences: what you checked, what you did not, and what
  breaks if you are wrong. Leave out what the title already says.
- **Steps:** number the 3-8 notes that tell the story in reading order (entry point first, follow
  the data flow). Other notes still show inline.
- **Large changes:** mark `high` on the few files that carry the change, mark families `noise` with
  globs (`"Assets/Generated/**"`), say in the brief which folders are mechanical, and annotate a
  repeated pattern once.
- **Be honest:** uncertainty is `risk`, shortcuts are `todo`, and `verify` only for what you ran.

## Hand off

Tell the user the review is ready: `sift` opens it (`sift url` prints the address if it is already
running). Do not start the server yourself; it is a long-running process.

## Review comments

```bash
sift feedback                                   # open comments, with ids and the code they point at
sift reply <id> "What you changed, or why not" --resolve
```

Reply to every comment, in English. Resolve it when it is handled; leave it open if you need the
reviewer's input. Add notes for anything new that deserves attention, and `sift end` once the user
is satisfied.

## Notes

- Several agents in one repo: pass `--session <id>` (printed by `begin`) or `export SIFT_SESSION=<id>`.
- Forgot `sift begin`? The first note starts a session based on HEAD.
- Data lives in `<repo>/.sift/` (git-ignored) and baselines under `refs/sift/`. Never commit or
  delete either.
- `sift status`, `sift sessions`, `sift use <id>`, `sift help`.
