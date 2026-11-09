import type { DiffLine, DiffOut, FileEntry, Importance, NoteKind, ResolvedFeedback, ResolvedNote, Side } from './types.ts';

// ---- vocabulary ---------------------------------------------------------------------------

export const KIND: Record<NoteKind, { label: string; hint: string }> = {
  important: { label: 'Look here', hint: 'The agent thinks this needs your eyes' },
  risk: { label: 'Risk', hint: 'Could break something or is uncertain' },
  question: { label: 'Question', hint: 'The agent needs a decision from you' },
  todo: { label: 'Follow-up', hint: 'Left undone on purpose' },
  why: { label: 'Why', hint: 'The reasoning behind a choice' },
  verify: { label: 'Checked', hint: 'How this was verified' },
  info: { label: 'Note', hint: 'Context worth knowing' },
};

export const KIND_ORDER: NoteKind[] = ['important', 'risk', 'question', 'todo', 'why', 'verify', 'info'];
export const ATTENTION_KINDS = new Set<NoteKind>(['important', 'risk', 'question', 'todo']);

export const BANDS: { id: string; label: string; levels: Importance[] }[] = [
  { id: 'focus', label: 'Start here', levels: ['critical', 'high'] },
  { id: 'normal', label: 'Changes', levels: ['normal'] },
  { id: 'low', label: 'Low signal', levels: ['low'] },
  { id: 'noise', label: 'Noise', levels: ['noise'] },
];

const IMPORTANCE_RANK: Record<Importance, number> = { critical: 0, high: 1, normal: 2, low: 3, noise: 4 };

export const STATUS_LABEL: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Mode changed',
};

// ---- ordering -----------------------------------------------------------------------------

/** Reading order: importance band, then walkthrough order, then files with notes, then path. */
export function orderFiles(files: FileEntry[], notes: ResolvedNote[]): FileEntry[] {
  const firstStep = new Map<string, number>();
  const noted = new Set<string>();
  for (const n of notes) {
    if (!n.file) continue;
    noted.add(n.file);
    if (n.step != null) firstStep.set(n.file, Math.min(firstStep.get(n.file) ?? Infinity, n.step));
  }
  return [...files].sort((a, b) => {
    const r = IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance];
    if (r) return r;
    const sa = firstStep.get(a.path) ?? Infinity;
    const sb = firstStep.get(b.path) ?? Infinity;
    if (sa !== sb) return sa - sb;
    const na = noted.has(a.path) ? 0 : 1;
    const nb = noted.has(b.path) ? 0 : 1;
    if (na !== nb) return na - nb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** The walkthrough: notes with steps, or every note in reading order when none have steps. */
export function tourNotes(notes: ResolvedNote[], orderedFiles: FileEntry[]): ResolvedNote[] {
  const stepped = notes.filter((n) => n.step != null).sort((a, b) => a.step! - b.step!);
  if (stepped.length) return stepped;
  const fileIdx = new Map(orderedFiles.map((f, i) => [f.path, i]));
  return [...notes].sort((a, b) => {
    const fa = a.file ? (fileIdx.get(a.file) ?? 1e6) : -1;
    const fb = b.file ? (fileIdx.get(b.file) ?? 1e6) : -1;
    if (fa !== fb) return fa - fb;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

// ---- rows ---------------------------------------------------------------------------------

export interface LineRow extends DiffLine {
  type: 'line';
  hunkStart?: boolean;
}

export interface HiddenRow {
  type: 'hidden';
  key: string;
  /** New-side line numbers, inclusive. Old line = new line + delta. */
  from: number;
  to: number;
  delta: number;
  header?: string;
  expandable: boolean;
}

export type Row = LineRow | HiddenRow;
export type Interval = [number, number];

export function mergeIntervals(list: Interval[]): Interval[] {
  const s = list.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

export type LineLookup = (n: number) => [string, number[]] | undefined;

/**
 * Unified rows for a file. Unchanged stretches between hunks stay hidden unless revealed by the
 * user or pinned open by an annotation; lines not fetched yet are reported in `want`.
 */
export function buildRows(file: FileEntry, diff: DiffOut, reveal: Interval[], pins: number[], line: LineLookup): { rows: Row[]; want: Interval[] } {
  const rows: Row[] = [];
  const want: Interval[] = [];
  const canExpand = !!file.newBlob;

  const gap = (a: number, b: number, delta: number, header?: string) => {
    if (b < a) return;
    if (!canExpand) {
      rows.push({ type: 'hidden', key: `${a}`, from: a, to: b, delta, header, expandable: false });
      return;
    }
    const visible = mergeIntervals([
      ...reveal.map(([x, y]) => [Math.max(a, x), Math.min(b, y)] as Interval),
      ...pins.filter((l) => l >= a && l <= b).map((l) => [Math.max(a, l - 2), Math.min(b, l + 2)] as Interval),
    ]);
    let cur = a;
    const hidden = (x: number, y: number, last: boolean) => {
      if (y >= x) rows.push({ type: 'hidden', key: `${x}`, from: x, to: y, delta, header: last ? header : undefined, expandable: true });
    };
    for (const [x, y] of visible) {
      // Only show a revealed stretch once every line in it has arrived, so rows do not trickle in.
      let ok = true;
      for (let l = x; l <= y && ok; l++) if (!line(l)) ok = false;
      if (!ok) {
        want.push([x, y]);
        continue;
      }
      hidden(cur, x - 1, false);
      for (let l = x; l <= y; l++) {
        const [s, k] = line(l)!;
        rows.push({ type: 'line', t: ' ', s, k: k.length ? k : undefined, n: l, o: l + delta });
      }
      cur = y + 1;
    }
    hidden(cur, b, true);
  };

  let nextNew = 1;
  let delta = 0;
  for (const h of diff.hunks) {
    gap(nextNew, h.ns - 1, h.os - h.ns, h.header || undefined);
    h.lines.forEach((l, i) => rows.push(i === 0 ? { type: 'line', ...l, hunkStart: true } : { type: 'line', ...l }));
    nextNew = h.ns + h.nl;
    delta = h.os + h.ol - (h.ns + h.nl);
  }
  if (canExpand && diff.hunks.length) gap(nextNew, diff.newLines, delta);
  return { rows, want };
}

export interface SplitRow {
  type: 'split';
  left?: LineRow;
  right?: LineRow;
  hunkStart?: boolean;
}

/** Pair deletions with additions for side-by-side display. */
export function toSplit(rows: Row[]): (SplitRow | HiddenRow)[] {
  const out: (SplitRow | HiddenRow)[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.type === 'hidden') {
      out.push(r);
      i++;
      continue;
    }
    if (r.t === ' ') {
      out.push({ type: 'split', left: r, right: r, hunkStart: r.hunkStart });
      i++;
      continue;
    }
    const dels: LineRow[] = [];
    const adds: LineRow[] = [];
    const start = r.hunkStart;
    while (i < rows.length && rows[i].type === 'line' && (rows[i] as LineRow).t === '-') dels.push(rows[i++] as LineRow);
    while (i < rows.length && rows[i].type === 'line' && (rows[i] as LineRow).t === '+') adds.push(rows[i++] as LineRow);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      out.push({ type: 'split', left: dels[k], right: adds[k], hunkStart: k === 0 && (start || dels[0]?.hunkStart || adds[0]?.hunkStart) });
  }
  return out;
}

// ---- anchoring ----------------------------------------------------------------------------

export type Anchored = { kind: 'note'; item: ResolvedNote } | { kind: 'feedback'; item: ResolvedFeedback };

export function anchorKey(side: Side, line: number) {
  return `${side}:${line}`;
}

export function rowKeys(r: LineRow): string[] {
  const keys: string[] = [];
  if (r.t !== '-' && r.n != null) keys.push(anchorKey('new', r.n));
  if (r.t !== '+' && r.o != null) keys.push(anchorKey('old', r.o));
  return keys;
}

export interface FileAnnotations {
  /** side:lastLine -> annotations drawn under that row */
  anchored: Map<string, Anchored[]>;
  /** side:line -> range bar colour */
  ranges: Map<string, { kind: NoteKind | 'feedback'; start: boolean }>;
  fileLevel: Anchored[];
  /** New-side lines that must stay visible. */
  pins: number[];
  sig: string;
}

export function fileAnnotations(notes: ResolvedNote[], feedback: ResolvedFeedback[]): FileAnnotations {
  const anchored = new Map<string, Anchored[]>();
  const ranges = new Map<string, { kind: NoteKind | 'feedback'; start: boolean }>();
  const fileLevel: Anchored[] = [];
  const pins: number[] = [];
  const items: Anchored[] = [
    ...notes.map((n) => ({ kind: 'note' as const, item: n })),
    ...feedback.map((f) => ({ kind: 'feedback' as const, item: f })),
  ];
  for (const a of items) {
    const it = a.item;
    if (!it.line || it.stale) {
      fileLevel.push(a);
      continue;
    }
    const end = it.endLine ?? it.line;
    const key = anchorKey(it.side, end);
    (anchored.get(key) ?? anchored.set(key, []).get(key)!).push(a);
    const kind = a.kind === 'note' ? a.item.kind : 'feedback';
    for (let l = it.line; l <= end; l++) {
      const k = anchorKey(it.side, l);
      if (!ranges.has(k)) ranges.set(k, { kind, start: l === it.line });
    }
    if (it.side === 'new') {
      pins.push(it.line);
      if (end !== it.line) pins.push(end);
    }
  }
  for (const list of anchored.values())
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'note' ? -1 : 1;
      if (a.kind === 'note' && b.kind === 'note') return KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind);
      return 0;
    });
  const sig = items.map((a) => `${a.item.id}:${a.item.side}:${a.item.line}-${a.item.endLine}${a.item.stale ? 's' : ''}`).join(',');
  return { anchored, ranges, fileLevel, pins, sig };
}

// ---- misc ---------------------------------------------------------------------------------

export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** First line of markdown as plain text, for one-line previews. */
export function plainSnippet(md: string): string {
  const first = md.split('\n').find((l) => l.trim()) ?? '';
  return first.replace(/[*_`#>~]|\[([^\]]*)\]\([^)]*\)/g, (_m, link) => link ?? '').trim();
}

export function fmt(n: number) {
  return n.toLocaleString('en-US');
}
