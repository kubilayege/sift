import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { content, useContentVersion } from '../api.ts';
import {
  KIND,
  KIND_ORDER,
  STATUS_LABEL,
  anchorKey,
  buildRows,
  fileAnnotations,
  fmt,
  mergeIntervals,
  rowKeys,
  splitPath,
  toSplit,
  type Anchored,
  type FileAnnotations,
  type HiddenRow,
  type Interval,
  type LineRow,
  type SplitRow,
} from '../model.ts';
import { useReview, type ComposerTarget } from '../state.ts';
import type { FileEntry, NoteKind, ResolvedFeedback, ResolvedNote, Side } from '../types.ts';
import { Code, Composer, FeedbackThread, NoteCard } from './Annotations.tsx';

// ---- items ----------------------------------------------------------------------------------
//
// The whole review is one flat list of items (brief, file headers, diff rows, annotation blocks)
// rendered through a virtualizer, so only what is on screen exists in the DOM no matter how many
// files or lines the change has. Files that have not been fetched yet are a single placeholder
// sized from the server's row count, so the scrollbar is right before anything loads.

type Ann = { kind: 'note' | 'feedback'; id: string };

type Item =
  | { kind: 'brief'; key: string }
  | { kind: 'head'; key: string; file: FileEntry }
  | { kind: 'top'; key: string; file: FileEntry; anns: Ann[]; composer: boolean }
  | { kind: 'msg'; key: string; file: FileEntry; msg: 'binary' | 'large' | 'loading' | 'empty' | 'error' | 'too-large' | 'same'; text?: string }
  | { kind: 'row'; key: string; file: FileEntry; row: LineRow | HiddenRow; fa: FileAnnotations; nw: number }
  | { kind: 'split'; key: string; file: FileEntry; row: SplitRow | HiddenRow; fa: FileAnnotations; nw: number }
  | { kind: 'annot'; key: string; file: FileEntry; anns: Ann[]; composer: boolean }
  | { kind: 'foot'; key: string; file: FileEntry; collapsed: boolean }
  | { kind: 'end'; key: string }
  | { kind: 'empty'; key: string };

const ROW = 20;

function estimate(it: Item): number {
  switch (it.kind) {
    case 'brief':
      return 420;
    case 'head':
      return 46;
    case 'top':
      return 64 + it.anns.length * 90;
    case 'msg':
      return it.msg === 'loading' ? Math.max(48, it.file.rows * ROW + it.file.hunks * 30) : 52;
    case 'row':
    case 'split':
      return it.row.type === 'hidden' ? 30 : ROW;
    case 'annot':
      return 24 + it.anns.length * 110 + (it.composer ? 150 : 0);
    case 'foot':
      return it.collapsed ? 10 : 18;
    case 'end':
      return 90;
    case 'empty':
      return 200;
  }
}

const toAnn = (a: Anchored): Ann => ({ kind: a.kind, id: a.item.id });

/** Places worth stopping at when stepping through the review with the arrow keys. */
const isStop = (it: Item) =>
  it.kind === 'top' || it.kind === 'annot' || it.kind === 'msg' || ((it.kind === 'row' || it.kind === 'split') && it.row.type !== 'hidden' && !!it.row.hunkStart);

const PAD = 52; // room for the sticky file header
type Align = 'start' | 'center' | 'end' | 'focus';
const FOCUS = 0.3; // stops land this far down the pane, so the lines above stay in view

export interface StreamApi {
  scrollToFile: (path: string) => void;
  scrollToNote: (id: string) => void;
  scrollToFeedback: (id: string) => void;
  hunk: (dir: 1 | -1) => void;
  /** Move the reading cursor to the next / previous stop: a hunk, a note, a comment, a file summary. */
  step: (dir: 1 | -1) => void;
  top: () => void;
}

interface Props {
  files: FileEntry[];
  collapsed: Set<string>;
  forceLoad: Set<string>;
  onToggle: (path: string, open?: boolean) => void;
  onForceLoad: (path: string) => void;
  onViewed: (f: FileEntry, v: boolean) => void;
  onActiveFile: (path: string | null) => void;
  brief: ReactNode;
  emptyText: string;
  scrollEl: HTMLElement | null;
  apiRef: Ref<StreamApi>;
}

const EMPTY_FA: FileAnnotations = { anchored: new Map(), ranges: new Map(), fileLevel: [], pins: [], sig: '' };

export function Stream(p: Props) {
  const { review, view, ws, composer, notesById, feedbackById } = useReview();
  const version = useContentVersion();
  const [reveal, setReveal] = useState<Map<string, Interval[]>>(new Map());
  const cache = useRef(new Map<string, { sig: string; items: Item[]; want: Interval[] }>());

  // Annotations grouped by file.
  const annByFile = useMemo(() => {
    const notes = new Map<string, ResolvedNote[]>();
    const fb = new Map<string, ResolvedFeedback[]>();
    for (const n of review.notes) if (n.file && n.inDiff) (notes.get(n.file) ?? notes.set(n.file, []).get(n.file)!).push(n);
    for (const f of review.feedback) if (f.file && f.inDiff) (fb.get(f.file) ?? fb.set(f.file, []).get(f.file)!).push(f);
    const out = new Map<string, FileAnnotations & { notes: ResolvedNote[]; feedback: ResolvedFeedback[] }>();
    for (const path of new Set([...notes.keys(), ...fb.keys()])) {
      const n = notes.get(path) ?? [];
      const f = fb.get(path) ?? [];
      out.set(path, { ...fileAnnotations(n, f), notes: n, feedback: f });
    }
    return out;
  }, [review.notes, review.feedback]);

  // ---- build the flat item list ------------------------------------------------------------
  const { items, wants } = useMemo(() => {
    const items: Item[] = [{ kind: 'brief', key: 'brief' }];
    const wants: { file: FileEntry; ranges: Interval[] }[] = [];
    if (!p.files.length) items.push({ kind: 'empty', key: 'empty' });
    const seen = new Set<string>();
    for (const file of p.files) {
      const path = file.path;
      seen.add(path);
      const collapsed = p.collapsed.has(path);
      const fa = annByFile.get(path) ?? EMPTY_FA;
      const here = composer && composer.file === path ? composer : null;
      const d = content.diff(file, ws);
      const sig = [
        file.hash,
        collapsed ? 1 : 0,
        p.forceLoad.has(path) ? 1 : 0,
        view,
        ws ? 1 : 0,
        JSON.stringify(reveal.get(path) ?? []),
        fa.sig,
        here ? `${here.side}:${here.line}-${here.endLine}` : '',
        content.linesVersion(file.newBlob),
        d ? (d instanceof Error ? 'e' : 'd') : '-',
        file.summary ?? '',
      ].join('|');
      let entry = cache.current.get(path);
      if (!entry || entry.sig !== sig) {
        entry = { sig, ...fileItems(file, collapsed, p.forceLoad.has(path), fa, here, reveal.get(path) ?? [], view, ws) };
        cache.current.set(path, entry);
      }
      for (const it of entry.items) items.push(it);
      if (entry.want.length) wants.push({ file, ranges: entry.want });
    }
    for (const k of cache.current.keys()) if (!seen.has(k)) cache.current.delete(k);
    if (p.files.length) items.push({ kind: 'end', key: 'end' });
    return { items, wants };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.files, p.collapsed, p.forceLoad, annByFile, composer, reveal, view, ws, version]);

  // Fetch context lines that revealed or pinned stretches need.
  useEffect(() => {
    for (const w of wants) if (w.file.newBlob) content.requestLines(w.file.newBlob, w.file.path, w.ranges);
  }, [wants]);

  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => p.scrollEl,
    estimateSize: (i) => estimate(items[i]),
    getItemKey: (i) => items[i].key,
    overscan: 12,
    scrollPaddingStart: 52,
  });
  const virtual = v.getVirtualItems();

  // Load diffs for files on screen, plus a few ahead.
  useEffect(() => {
    if (!virtual.length) return;
    const want: FileEntry[] = [];
    for (const vi of virtual) {
      const it = items[vi.index];
      if (it?.kind === 'msg' && it.msg === 'loading') want.push(it.file);
    }
    const last = items[virtual[virtual.length - 1].index];
    if (last && 'file' in last) {
      let idx = p.files.indexOf(last.file);
      for (let n = 0; n < 4 && ++idx < p.files.length; ) {
        const f = p.files[idx];
        if (p.collapsed.has(f.path) || f.binary || (f.large && !p.forceLoad.has(f.path))) continue;
        want.push(f);
        n++;
      }
    }
    // Requested last = fetched first, so the file in view wins over prefetches.
    for (const f of want.reverse()) content.requestDiff(f, ws);
  });

  // Which file is at the top of the pane (drives the sticky header, the sidebar highlight and every
  // shortcut that acts on "the current file"). Measured below the sticky header: what sits under it
  // is hidden, and a jump puts the file's header right there, so the file above must not count.
  const offset = v.scrollOffset ?? 0;
  const firstVisible = virtual.find((vi) => vi.end > offset + PAD + 2);
  const topItem = firstVisible ? items[firstVisible.index] : undefined;
  const activeFile = topItem && 'file' in topItem ? topItem.file : null;
  const showSticky = !!activeFile && topItem!.kind !== 'head' && !p.collapsed.has(activeFile.path);
  useEffect(() => {
    p.onActiveFile(activeFile?.path ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path]);

  // ---- imperative navigation -----------------------------------------------------------------
  const pending = useRef<{ match: (it: Item) => boolean; file?: string; tries: number; align: 'start' | 'center' } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // The reading cursor: the item the keyboard last moved to. Arrow keys continue from it while it
  // is on screen, and from the scroll position once the reader has scrolled elsewhere.
  const [cursor, setCursor] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const mark = (key: string | null) => {
    cursorRef.current = key;
    setCursor(key);
  };

  // Jumps hold on to their target by key, not index, until the layout settles: diffs that load on
  // the way (or right above the target) replace one placeholder with hundreds of rows, which shifts
  // every index after it and used to leave the pane in the previous file. Any scroll by the reader
  // lets go immediately.
  const pin = useRef<{ key: string; align: Align; until: number } | null>(null);
  const offsetFor = (idx: number, align: Align) => {
    if (align !== 'focus') return v.getOffsetForIndex(idx, align)?.[0];
    const at = v.getOffsetForIndex(idx, 'start');
    return at && Math.max(0, at[0] - ((p.scrollEl?.clientHeight ?? 0) - PAD) * FOCUS);
  };
  const settle = () => {
    const pn = pin.current;
    if (!pn) return;
    if (performance.now() > pn.until) return void (pin.current = null);
    const idx = itemsRef.current.findIndex((it) => it.key === pn.key);
    const off = idx >= 0 ? offsetFor(idx, pn.align) : undefined;
    if (off != null && Math.abs((v.scrollOffset ?? 0) - off) > 1) v.scrollToOffset(off);
  };
  const scrollTo = (idx: number, align: Align) => {
    const key = itemsRef.current[idx].key;
    mark(key);
    pin.current = { key, align, until: performance.now() + 3000 };
    settle();
  };
  useLayoutEffect(settle);
  useEffect(() => {
    const el = p.scrollEl;
    if (!el) return;
    const release = () => (pin.current = null);
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) release();
    };
    el.addEventListener('wheel', release, { passive: true });
    el.addEventListener('touchstart', release, { passive: true });
    el.addEventListener('mousedown', release);
    window.addEventListener('keydown', onKey, true);
    return () => {
      el.removeEventListener('wheel', release);
      el.removeEventListener('touchstart', release);
      el.removeEventListener('mousedown', release);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [p.scrollEl]);

  const go = (match: (it: Item) => boolean, align: 'start' | 'center', file?: string) => {
    const idx = itemsRef.current.findIndex(match);
    if (idx >= 0) {
      scrollTo(idx, align);
      return true;
    }
    pending.current = { match, file, tries: 40, align };
    if (file) {
      p.onToggle(file, true);
      const f = p.files.find((x) => x.path === file);
      if (f) {
        if (f.large) p.onForceLoad(file);
        content.requestDiff(f, ws);
      }
    }
    return false;
  };

  useEffect(() => {
    const pend = pending.current;
    if (!pend) return;
    const idx = items.findIndex(pend.match);
    if (idx >= 0) {
      pending.current = null;
      scrollTo(idx, pend.align);
    } else if (--pend.tries <= 0) pending.current = null;
  });

  const hasAnn = (kind: 'note' | 'feedback', id: string) => (it: Item) =>
    (it.kind === 'annot' || it.kind === 'top') && it.anns.some((a) => a.kind === kind && a.id === id);

  useImperativeHandle(p.apiRef, () => ({
    scrollToFile: (path) => {
      go((it) => it.kind === 'head' && it.file.path === path, 'start');
    },
    scrollToNote: (id) => {
      const n = notesById.get(id);
      if (n && n.file && n.inDiff) go(hasAnn('note', id), 'center', n.file);
      else go((it) => it.kind === 'brief', 'start');
    },
    scrollToFeedback: (id) => {
      const f = feedbackById.get(id);
      if (f && f.file && f.inDiff) go(hasAnn('feedback', id), 'center', f.file);
      else go((it) => it.kind === 'brief', 'start');
    },
    hunk: (dir) => {
      const cur = firstVisible?.index ?? 0;
      const list = itemsRef.current;
      const isStart = (it: Item) => (it.kind === 'row' || it.kind === 'split') && it.row.type !== 'hidden' && !!it.row.hunkStart;
      if (dir > 0) {
        for (let i = cur + 3; i < list.length; i++) if (isStart(list[i])) return scrollTo(i, 'start');
      } else {
        for (let i = cur - 1; i >= 0; i--) if (isStart(list[i])) return scrollTo(i, 'start');
      }
    },
    step: (dir) => {
      const list = itemsRef.current;
      const m = v.measurementsCache;
      const top = v.scrollOffset ?? 0;
      const bottom = top + (p.scrollEl?.clientHeight ?? 0);
      const ci = cursorRef.current ? list.findIndex((it) => it.key === cursorRef.current) : -1;
      const onScreen = ci >= 0 && m[ci] && m[ci].end > top + PAD && m[ci].start < bottom;
      let next = -1;
      if (dir > 0) {
        for (let i = onScreen ? ci + 1 : 0; i < list.length && next < 0; i++)
          if (isStop(list[i]) && (onScreen || (m[i]?.start ?? 0) >= top + PAD)) next = i;
        if (next < 0) return list.length ? scrollTo(list.length - 1, 'end') : undefined;
      } else {
        for (let i = onScreen ? ci - 1 : list.length - 1; i >= 0 && next < 0; i--)
          if (isStop(list[i]) && (onScreen || (m[i]?.start ?? 0) < top + PAD - 1)) next = i;
        if (next < 0) {
          pin.current = null;
          v.scrollToOffset(0);
          return mark(null);
        }
      }
      // A stop already sitting in the upper part of the pane just takes the cursor; no scroll jump.
      const at = m[next];
      const comfy = at && at.start >= top + PAD && at.start <= top + PAD + (bottom - top - PAD) * 0.6;
      if (comfy) {
        pin.current = null;
        mark(list[next].key);
      } else scrollTo(next, 'focus');
    },
    top: () => {
      pin.current = null;
      v.scrollToOffset(0);
      mark(null);
    },
  }));

  const addReveal = (path: string, iv: Interval) =>
    setReveal((m) => {
      const n = new Map(m);
      n.set(path, mergeIntervals([...(m.get(path) ?? []), iv]));
      return n;
    });

  const kindsByFile = (path: string) => {
    const fa = annByFile.get(path);
    const m = new Map<NoteKind, number>();
    for (const n of fa?.notes ?? []) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    const open = (fa?.feedback ?? []).filter((f) => f.status === 'open').length;
    return { kinds: KIND_ORDER.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const), open };
  };

  const head = (file: FileEntry, sticky = false) => (
    <FileHead
      file={file}
      sticky={sticky}
      collapsed={p.collapsed.has(file.path)}
      viewed={review.viewed[file.path] === file.hash ? 'yes' : review.viewed[file.path] ? 'changed' : 'no'}
      counts={kindsByFile(file.path)}
      onToggle={() => p.onToggle(file.path)}
      onViewed={(val) => p.onViewed(file, val)}
      onJump={() => go((it) => it.kind === 'head' && it.file.path === file.path, 'start')}
    />
  );

  const render = (it: Item): ReactNode => {
    switch (it.kind) {
      case 'brief':
        return p.brief;
      case 'empty':
        return (
          <div className="empty">
            <h2>Nothing changed in this view.</h2>
            <p>{p.emptyText}</p>
          </div>
        );
      case 'end': {
        const viewed = p.files.filter((f) => review.viewed[f.path] === f.hash).length;
        return <footer className="end">{viewed === p.files.length ? 'Every file is marked viewed.' : `End of changes. ${viewed} of ${p.files.length} files viewed.`}</footer>;
      }
      case 'head':
        return head(it.file);
      case 'foot':
        return <div className={`file-foot ${it.collapsed ? 'is-collapsed' : ''}`} />;
      case 'top':
        return <FileTop file={it.file} anns={it.anns} composer={it.composer} />;
      case 'msg':
        return <FileMsg item={it} onForce={() => p.onForceLoad(it.file.path)} />;
      case 'annot':
        return <AnnotBlock anns={it.anns} composer={it.composer ? composer : null} />;
      case 'row':
        return it.row.type === 'hidden' ? (
          <Gap row={it.row} cols="unified" onReveal={(iv) => addReveal(it.file.path, iv)} />
        ) : (
          <UnifiedRow file={it.file.path} row={it.row} fa={it.fa} nw={it.nw} sel={selFor(composer, it.file.path)} />
        );
      case 'split':
        return it.row.type === 'hidden' ? (
          <Gap row={it.row} cols="split" onReveal={(iv) => addReveal(it.file.path, iv)} />
        ) : (
          <SplitLine file={it.file.path} row={it.row} fa={it.fa} nw={it.nw} sel={selFor(composer, it.file.path)} />
        );
    }
  };

  return (
    <>
      <div className="sticky-slot">{showSticky && activeFile && head(activeFile, true)}</div>
      <div className="vlist" style={{ height: v.getTotalSize() }}>
        {virtual.map((vi) => {
          const it = items[vi.index];
          return (
            <div key={vi.key} data-index={vi.index} ref={v.measureElement} className={`vi vi-${it.kind} ${it.key === cursor ? 'is-cursor' : ''}`} style={{ transform: `translateY(${vi.start}px)` }}>
              {render(it)}
            </div>
          );
        })}
      </div>
    </>
  );
}

function selFor(c: ComposerTarget | null, path: string): string {
  return c && c.file === path && c.line ? `${c.side}:${c.line}:${c.endLine ?? c.line}` : '';
}

/** Items for one file. Pure; cached by the caller on a signature of everything it reads. */
function fileItems(
  file: FileEntry,
  collapsed: boolean,
  force: boolean,
  fa: FileAnnotations,
  composer: ComposerTarget | null,
  reveal: Interval[],
  view: 'unified' | 'split',
  ws: boolean,
): { items: Item[]; want: Interval[] } {
  const path = file.path;
  const items: Item[] = [{ kind: 'head', key: `h:${path}`, file }];
  const foot = (): Item => ({ kind: 'foot', key: `f:${path}`, file, collapsed });
  if (collapsed) return { items: [...items, foot()], want: [] };

  const fileComposer = !!composer && !composer.line;
  if (file.summary || fa.fileLevel.length || fileComposer)
    items.push({ kind: 'top', key: `t:${path}`, file, anns: fa.fileLevel.map(toAnn), composer: fileComposer });

  const msg = (m: Extract<Item, { kind: 'msg' }>['msg'], text?: string) => {
    items.push({ kind: 'msg', key: `m:${path}:${m}`, file, msg: m, text });
    items.push(foot());
    return { items, want: [] };
  };
  if (file.binary) return msg('binary');
  if (file.large && !force) return msg('large');
  if (!file.oldBlob && !file.newBlob) return msg('empty');
  const d = content.diff(file, ws);
  if (!d) return msg('loading');
  if (d instanceof Error) return msg('error', d.message);
  if (d.binary) return msg('binary');
  if (d.tooLarge) return msg('too-large');
  if (!d.hunks.length) return msg('same');

  const pins = [...fa.pins];
  if (composer?.line && composer.side === 'new') pins.push(composer.endLine ?? composer.line);
  const blob = file.newBlob;
  const { rows, want } = buildRows(file, d, reveal, pins, (n) => (blob ? content.line(blob, n) : undefined));
  const nw = String(Math.max(d.oldLines, d.newLines, 1)).length;

  const composerKey = composer?.line ? anchorKey(composer.side, composer.endLine ?? composer.line) : '';
  const emitted = new Set<string>();
  const annAfter = (keys: string[], idx: string) => {
    const anns: Ann[] = [];
    for (const k of keys) {
      if (emitted.has(k)) continue;
      const list = fa.anchored.get(k);
      if (list) {
        emitted.add(k);
        anns.push(...list.map(toAnn));
      }
    }
    const withComposer = !!composerKey && keys.includes(composerKey) && !emitted.has('composer');
    if (withComposer) emitted.add('composer');
    if (anns.length || withComposer) items.push({ kind: 'annot', key: `a:${path}:${idx}`, file, anns, composer: withComposer });
  };
  // Annotations whose line is inside a still-hidden stretch show under that stretch.
  const hiddenKeys = (h: HiddenRow) => {
    const keys: string[] = [];
    const scan = (side: Side, a: number, b: number) => {
      for (const k of [...fa.anchored.keys(), composerKey]) {
        if (!k.startsWith(side + ':')) continue;
        const l = +k.slice(side.length + 1);
        if (l >= a && l <= b) keys.push(k);
      }
    };
    scan('new', h.from, h.to);
    scan('old', h.from + h.delta, h.to + h.delta);
    return keys;
  };

  if (view === 'unified') {
    rows.forEach((r, i) => {
      items.push({ kind: 'row', key: `r:${path}:${r.type === 'hidden' ? `h${r.key}` : `${r.o ?? ''}-${r.n ?? ''}`}`, file, row: r, fa, nw });
      annAfter(r.type === 'hidden' ? hiddenKeys(r) : rowKeys(r), String(i));
    });
  } else {
    toSplit(rows).forEach((r, i) => {
      const key = r.type === 'hidden' ? `h${r.key}` : `${r.left?.o ?? ''}-${r.right?.n ?? ''}-${r.left?.t ?? ''}${r.right?.t ?? ''}`;
      items.push({ kind: 'split', key: `s:${path}:${key}`, file, row: r, fa, nw });
      if (r.type === 'hidden') annAfter(hiddenKeys(r), String(i));
      else annAfter([...new Set([...(r.left ? rowKeys(r.left) : []), ...(r.right ? rowKeys(r.right) : [])])], String(i));
    });
  }
  // Anything still unplaced (line outside every hunk and gap) goes after the last row.
  const rest = [...fa.anchored.keys()].filter((k) => !emitted.has(k));
  if (rest.length) annAfter(rest, 'rest');
  items.push(foot());
  return { items, want };
}

// ---- pieces -------------------------------------------------------------------------------

const IMPORTANCE_LABEL: Record<string, string> = { critical: 'Critical', high: 'Important', low: 'Low signal', noise: 'Noise' };

const FileHead = memo(function FileHead({
  file,
  sticky,
  collapsed,
  viewed,
  counts,
  onToggle,
  onViewed,
  onJump,
}: {
  file: FileEntry;
  sticky: boolean;
  collapsed: boolean;
  viewed: 'yes' | 'changed' | 'no';
  counts: { kinds: (readonly [NoteKind, number])[]; open: number };
  onToggle: () => void;
  onViewed: (v: boolean) => void;
  onJump: () => void;
}) {
  const { selectLine } = useReview();
  const [dir, base] = splitPath(file.path);
  return (
    <header className={`file-head imp-${file.importance} ${collapsed ? 'is-collapsed' : ''} ${viewed === 'yes' ? 'is-viewed' : ''} ${sticky ? 'is-sticky' : ''}`}>
      <button className="chev" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand file' : 'Collapse file'}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span className={`fstatus s-${file.status}`} title={STATUS_LABEL[file.status]}>
        {file.status}
      </span>
      <button className="fpath" onClick={sticky ? onJump : onToggle} title={sticky ? 'Back to the top of this file' : file.path}>
        {dir && <span className="dir">{dir}</span>}
        <span className="base">{base}</span>
      </button>
      {file.oldPath && <span className="renamed">from {file.oldPath}</span>}
      <span className="head-spacer" />
      {counts.kinds.map(([k, c]) => (
        <span key={k} className={`kdot k-${k}`} title={`${c} × ${KIND[k].label}`}>
          {c}
        </span>
      ))}
      {counts.open > 0 && (
        <span className="kdot k-feedback" title={`${counts.open} open comment${counts.open === 1 ? '' : 's'}`}>
          {counts.open}
        </span>
      )}
      {file.importance !== 'normal' && (
        <span className={`imp-tag imp-${file.importance}`} title={file.importanceSource === 'auto' ? 'Detected from the file type' : 'Set by the agent'}>
          {IMPORTANCE_LABEL[file.importance]}
        </span>
      )}
      <span className="churn">
        {file.additions > 0 && <span className="add">+{fmt(file.additions)}</span>}
        {file.deletions > 0 && <span className="del">−{fmt(file.deletions)}</span>}
      </span>
      <button
        className="file-comment"
        title="Comment on this file"
        onClick={() => {
          if (collapsed) onToggle();
          selectLine(file.path, 'new', 0, false);
        }}
      >
        Comment
      </button>
      <label className={`viewed ${viewed === 'changed' ? 'is-changed' : ''}`} title={viewed === 'changed' ? 'Changed since you marked it viewed' : 'Mark as viewed (v)'}>
        <input type="checkbox" checked={viewed === 'yes'} onChange={(e) => onViewed(e.target.checked)} />
        <span>{viewed === 'changed' ? 'Changed' : 'Viewed'}</span>
      </label>
    </header>
  );
});

function useAnns(anns: Ann[]) {
  const { notesById, feedbackById } = useReview();
  return anns.map((a) => (a.kind === 'note' ? notesById.get(a.id) : feedbackById.get(a.id)) && a).filter(Boolean) as Ann[];
}

function AnnList({ anns }: { anns: Ann[] }) {
  const { notesById, feedbackById } = useReview();
  return (
    <>
      {useAnns(anns).map((a) =>
        a.kind === 'note' ? <NoteCard key={a.id} note={notesById.get(a.id)!} /> : <FeedbackThread key={a.id} item={feedbackById.get(a.id)!} />,
      )}
    </>
  );
}

function FileTop({ file, anns, composer }: { file: FileEntry; anns: Ann[]; composer: boolean }) {
  const { composer: target } = useReview();
  return (
    <div className="file-top">
      {file.summary && <p className="file-summary">{file.summary}</p>}
      <AnnList anns={anns} />
      {composer && target && <Composer target={target} />}
    </div>
  );
}

function AnnotBlock({ anns, composer }: { anns: Ann[]; composer: ComposerTarget | null }) {
  return (
    <div className="annot">
      <div className="annot-stack">
        <AnnList anns={anns} />
        {composer && <Composer target={composer} />}
      </div>
    </div>
  );
}

function FileMsg({ item, onForce }: { item: Extract<Item, { kind: 'msg' }>; onForce: () => void }) {
  const f = item.file;
  switch (item.msg) {
    case 'loading':
      return <div className="file-loading" style={{ height: Math.max(48, f.rows * ROW + f.hunks * 30) }} aria-busy />;
    case 'binary':
      return <p className="file-msg">Binary file. Open it in your editor to inspect.</p>;
    case 'large':
      return (
        <p className="file-msg">
          Large diff: {fmt(f.rows)} lines.{' '}
          <button className="btn link" onClick={onForce}>
            Load it
          </button>
        </p>
      );
    case 'too-large':
      return <p className="file-msg">Too large to diff in the browser ({fmt(f.newLines)} lines). Open it in your editor.</p>;
    case 'empty':
      return <p className="file-msg">{f.status === 'R' ? 'Renamed without content changes.' : 'No content changes (mode or submodule change).'}</p>;
    case 'same':
      return <p className="file-msg">{f.status === 'R' ? 'Renamed without content changes.' : 'Only whitespace changed.'}</p>;
    case 'error':
      return <p className="file-msg error-inline">{item.text}</p>;
  }
}

function Gap({ row, cols, onReveal }: { row: HiddenRow; cols: 'unified' | 'split'; onReveal: (iv: Interval) => void }) {
  const count = row.to - row.from + 1;
  return (
    <div className={`gap gap-${cols}`}>
      {row.expandable ? (
        count > 40 ? (
          <>
            <button className="gap-btn" onClick={() => onReveal([row.from, row.from + 19])} title="Show 20 more lines below the change above">
              ↓ 20
            </button>
            <button className="gap-btn" onClick={() => onReveal([row.from, row.to])}>
              {fmt(count)} unchanged lines
            </button>
            <button className="gap-btn" onClick={() => onReveal([row.to - 19, row.to])} title="Show 20 more lines above the change below">
              ↑ 20
            </button>
          </>
        ) : (
          <button className="gap-btn" onClick={() => onReveal([row.from, row.to])}>
            Show {count} unchanged line{count === 1 ? '' : 's'}
          </button>
        )
      ) : (
        <span className="gap-label">
          {fmt(count)} unchanged line{count === 1 ? '' : 's'}
        </span>
      )}
      {row.header && <code className="gap-ctx">{row.header.trim()}</code>}
    </div>
  );
}

function decor(fa: FileAnnotations, sel: string, side: Side, line: number, altOld?: number): { cls: string; style?: CSSProperties } {
  const range = fa.ranges.get(anchorKey(side, line)) ?? (altOld ? fa.ranges.get(anchorKey('old', altOld)) : undefined);
  let selected = false;
  if (sel) {
    const [s, a, b] = sel.split(':');
    selected = s === side && line >= +a && line <= +b;
  }
  const cls = [range && 'has-range', range?.start && 'range-start', selected && 'is-selected'].filter(Boolean).join(' ');
  return { cls, style: range ? ({ '--mk': `var(--k-${range.kind})` } as CSSProperties) : undefined };
}

const sign = (t: string) => (t === '+' ? '+' : t === '-' ? '−' : '');
const tcls = (t: string) => (t === '+' ? 'add' : t === '-' ? 'del' : 'ctx');

function Num({ file, side, line, show }: { file: string; side: Side; line?: number; show?: number }) {
  const { selectLine } = useReview();
  if (line == null) return <span className="num" />;
  return (
    <span className="num clickable" title="Comment on this line (shift-click to extend)" onClick={(e) => selectLine(file, side, line, e.shiftKey)}>
      {show ?? line}
    </span>
  );
}

const UnifiedRow = memo(function UnifiedRow({ file, row, fa, nw, sel }: { file: string; row: LineRow; fa: FileAnnotations; nw: number; sel: string }) {
  const side: Side = row.t === '-' ? 'old' : 'new';
  const line = (side === 'old' ? row.o : row.n)!;
  const d = decor(fa, sel, side, line, row.t === ' ' ? row.o : undefined);
  return (
    <div className={`ln u ${tcls(row.t)} ${d.cls}`} style={{ ...d.style, '--nw': `${nw + 1.6}ch` } as CSSProperties}>
      {row.t === '+' ? <span className="num" /> : <Num file={file} side={row.t === '-' ? 'old' : 'new'} line={row.t === '-' ? row.o : row.n} show={row.o} />}
      {row.t === '-' ? <span className="num" /> : <Num file={file} side="new" line={row.n} />}
      <span className="sign">{sign(row.t)}</span>
      <span className="code">
        <Code text={row.s} k={row.k} e={row.e} />
      </span>
    </div>
  );
});

const SplitLine = memo(function SplitLine({ file, row, fa, nw, sel }: { file: string; row: SplitRow; fa: FileAnnotations; nw: number; sel: string }) {
  const { left, right } = row;
  const ctx = !!left && left === right;
  const half = (r: LineRow | undefined, which: 'l' | 'r') => {
    if (!r) return <span className="empty-side" />;
    const side: Side = which === 'l' && !ctx ? 'old' : 'new';
    const line = (side === 'old' ? r.o : r.n)!;
    const d = decor(fa, sel, side, line, ctx ? r.o : undefined);
    return (
      <>
        <Num file={file} side={side} line={line} show={which === 'l' ? r.o : r.n} />
        <span className={`sign ${tcls(r.t)} ${d.cls}`} style={d.style}>
          {sign(r.t)}
        </span>
        <span className={`code ${tcls(r.t)}`}>
          <Code text={r.s} k={r.k} e={r.e} />
        </span>
      </>
    );
  };
  return (
    <div className="ln s" style={{ '--nw': `${nw + 1.6}ch` } as CSSProperties}>
      {half(left, 'l')}
      {half(right, 'r')}
    </div>
  );
});
