import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { BANDS, KIND, KIND_ORDER, fmt, plainSnippet, splitPath } from '../model.ts';
import { useReview } from '../state.ts';
import type { FileEntry, NoteKind, ResolvedNote } from '../types.ts';
import { Stamp, location } from './Annotations.tsx';

type Tab = 'files' | 'notes' | 'comments';
type Mode = 'order' | 'tree';

type SRow =
  | { kind: 'band'; key: string; id: string; label: string; count: number; toggle: boolean; open: boolean }
  | { kind: 'dir'; key: string; path: string; name: string; depth: number; open: boolean; files: FileEntry[] }
  | { kind: 'file'; key: string; file: FileEntry; depth: number; showDir: boolean };

interface Props {
  files: FileEntry[];
  activeFile: string | null;
  filterRef: RefObject<HTMLInputElement | null>;
  onViewed: (files: FileEntry[], v: boolean) => void;
}

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: FileEntry[];
  all: FileEntry[];
}

function buildTree(files: FileEntry[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: new Map(), files: [], all: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    node.all.push(f);
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [], all: [] };
        node.dirs.set(parts[i], next);
      }
      next.all.push(f);
      node = next;
    }
    node.files.push(f);
  }
  return root;
}

/** A folder is open by default near the top (or everywhere in small changes); `toggled` flips that. */
function flattenTree(node: DirNode, toggled: Set<string>, depth: number, out: SRow[], openDepth: number) {
  const dirs = [...node.dirs.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (let d of dirs) {
    // Collapse chains of single-child directories into one row ("src/components").
    let name = d.name;
    while (d.files.length === 0 && d.dirs.size === 1) {
      d = [...d.dirs.values()][0];
      name += '/' + d.name;
    }
    const open = depth < openDepth !== toggled.has(d.path);
    out.push({ kind: 'dir', key: `d:${d.path}`, path: d.path, name, depth, open, files: d.all });
    if (open) flattenTree(d, toggled, depth + 1, out, openDepth);
  }
  for (const f of [...node.files].sort((a, b) => (a.path < b.path ? -1 : 1))) out.push({ kind: 'file', key: `f:${f.path}`, file: f, depth, showDir: false });
}

export function Sidebar({ files, activeFile, filterRef, onViewed }: Props) {
  const { review, jumpToFile, jumpToNote, jumpToFeedback } = useReview();
  const [tab, setTab] = useState<Tab>('files');
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('sift.sideMode') as Mode) ?? 'order');
  const [q, setQ] = useState('');
  const [hideViewed, setHideViewed] = useState(false);
  const [showNoise, setShowNoise] = useState(false);
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<NoteKind | null>(null);
  const [copied, setCopied] = useState(false);

  const isViewed = (f: FileEntry) => review.viewed[f.path] === f.hash;
  const noteKinds = useMemo(() => {
    const m = new Map<string, Set<NoteKind>>();
    for (const n of review.notes) if (n.file) (m.get(n.file) ?? m.set(n.file, new Set()).get(n.file)!).add(n.kind);
    return m;
  }, [review.notes]);
  const openByFile = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of review.feedback) if (f.file && f.status === 'open') m.set(f.file, (m.get(f.file) ?? 0) + 1);
    return m;
  }, [review.feedback]);

  const ql = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      files.filter(
        (f) => (!ql || f.path.toLowerCase().includes(ql) || f.summary?.toLowerCase().includes(ql)) && (!hideViewed || review.viewed[f.path] !== f.hash),
      ),
    [files, ql, hideViewed, review.viewed],
  );

  const rows = useMemo(() => {
    const out: SRow[] = [];
    if (mode === 'tree') {
      // Big changes start folded to the top two levels; filtering opens everything that matches.
      flattenTree(buildTree(shown), toggled, 0, out, ql || shown.length <= 150 ? Infinity : 2);
      return out;
    }
    for (const band of BANDS) {
      const list = shown.filter((f) => band.levels.includes(f.importance));
      if (!list.length) continue;
      const isNoise = band.id === 'noise';
      const open = !isNoise || showNoise || !!ql;
      out.push({ kind: 'band', key: `b:${band.id}`, id: band.id, label: band.label, count: list.length, toggle: isNoise, open });
      if (open) for (const f of list) out.push({ kind: 'file', key: `f:${f.path}`, file: f, depth: 0, showDir: true });
    }
    return out;
  }, [mode, shown, toggled, showNoise, ql]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === 'band' ? 34 : 30),
    getItemKey: (i) => rows[i].key,
    overscan: 16,
  });

  // Keep the file being read visible in the list.
  useEffect(() => {
    if (!activeFile || tab !== 'files') return;
    const idx = rows.findIndex((r) => r.kind === 'file' && r.file.path === activeFile);
    if (idx >= 0) v.scrollToIndex(idx, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  const maxChurn = useMemo(() => Math.max(1, ...files.map((f) => f.additions + f.deletions)), [files]);
  const viewedCount = files.filter(isViewed).length;
  const viewedLines = files.reduce((a, f) => a + (isViewed(f) ? f.additions + f.deletions : 0), 0);
  const totalLines = files.reduce((a, f) => a + f.additions + f.deletions, 0);
  const openComments = review.feedback.filter((f) => f.status === 'open');
  const unread = review.notes.filter((n) => !review.acked.includes(n.id)).length;

  const kindCounts = useMemo(() => {
    const m = new Map<NoteKind, number>();
    for (const n of review.notes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return m;
  }, [review.notes]);
  const notesShown = review.notes
    .filter((n) => !kindFilter || n.kind === kindFilter)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.step ?? 1e9) - (b.step ?? 1e9));

  const copyPrompt = () => {
    const text = `I left review comments in Sift. In ${review.source.kind === 'session' ? `session ${review.session?.id}` : 'this repo'}, run \`sift feedback\` to read them, address each one, and reply with \`sift reply <id> "<what you did>" --resolve\`.`;
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => prompt('Copy this for your agent:', text),
    );
    setTimeout(() => setCopied(false), 1800);
  };

  const fileRow = (r: Extract<SRow, { kind: 'file' }>) => {
    const f = r.file;
    const [dir, base] = splitPath(f.path);
    const kinds = KIND_ORDER.filter((k) => noteKinds.get(f.path)?.has(k));
    const viewed = isViewed(f);
    const changed = !!review.viewed[f.path] && !viewed;
    const churn = f.additions + f.deletions;
    const w = Math.max(2, Math.round((Math.sqrt(churn) / Math.sqrt(maxChurn)) * 36));
    return (
      <div className={`frow ${activeFile === f.path ? 'is-active' : ''} ${viewed ? 'is-viewed' : ''}`} style={{ paddingLeft: 6 + r.depth * 12 }}>
        <input
          type="checkbox"
          className="fcheck"
          checked={viewed}
          onChange={(e) => onViewed([f], e.target.checked)}
          aria-label={`Mark ${f.path} as viewed`}
          title={changed ? 'Changed since you viewed it' : 'Viewed'}
        />
        <button className="fbtn" onClick={() => jumpToFile(f.path)} title={f.summary ? `${f.path}\n${f.summary}` : f.path}>
          <span className={`fstatus s-${f.status}`}>{f.status}</span>
          <span className="fname">
            <span className="base">{base}</span>
            {r.showDir && dir && <span className="dir">{dir.replace(/\/$/, '')}</span>}
          </span>
          <span className="fmeta">
            {kinds.map((k) => (
              <i key={k} className={`dot k-${k}`} title={KIND[k].label} />
            ))}
            {openByFile.get(f.path) ? <i className="dot k-feedback" title="Open comments" /> : null}
            {changed && <i className="changed" title="Changed since viewed" />}
            <span className="spark" aria-hidden>
              <span className="spark-add" style={{ width: (w * f.additions) / Math.max(1, churn) }} />
              <span className="spark-del" style={{ width: (w * f.deletions) / Math.max(1, churn) }} />
            </span>
          </span>
        </button>
      </div>
    );
  };

  const dirRow = (r: Extract<SRow, { kind: 'dir' }>) => {
    const nViewed = r.files.filter(isViewed).length;
    const all = nViewed === r.files.length;
    const adds = r.files.reduce((a, f) => a + f.additions, 0);
    const dels = r.files.reduce((a, f) => a + f.deletions, 0);
    return (
      <div className={`drow ${all ? 'is-viewed' : ''}`} style={{ paddingLeft: 6 + r.depth * 12 }}>
        <input
          type="checkbox"
          className="fcheck"
          checked={all}
          ref={(el) => {
            if (el) el.indeterminate = nViewed > 0 && !all;
          }}
          onChange={(e) => onViewed(r.files, e.target.checked)}
          aria-label={`Mark everything in ${r.path} as viewed`}
          title={`${nViewed} of ${r.files.length} viewed. Click to mark the whole folder.`}
        />
        <button
          className="dbtn"
          onClick={() =>
            setToggled((c) => {
              const n = new Set(c);
              n.has(r.path) ? n.delete(r.path) : n.add(r.path);
              return n;
            })
          }
          aria-expanded={r.open}
        >
          <svg className="dchev" viewBox="0 0 16 16" width="10" height="10" aria-hidden>
            <path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="dname">{r.name}</span>
          <span className="dmeta">
            <span className="count">{r.files.length}</span>
            <span className="add">+{fmt(adds)}</span>
            <span className="del">−{fmt(dels)}</span>
          </span>
        </button>
      </div>
    );
  };

  return (
    <aside className="sidebar" aria-label="Navigator">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
          Files <span className="count">{fmt(files.length)}</span>
        </button>
        <button role="tab" aria-selected={tab === 'notes'} onClick={() => setTab('notes')}>
          Notes <span className="count">{unread || review.notes.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>
          Comments {openComments.length > 0 && <span className="count hot">{openComments.length}</span>}
        </button>
      </div>

      {tab === 'files' && (
        <>
          <div className="side-filter">
            <input
              ref={filterRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') {
                  setQ('');
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === 'Enter' && shown[0]) jumpToFile(shown[0].path);
              }}
              placeholder={`Filter ${fmt(files.length)} files`}
              aria-label="Filter files"
            />
            <kbd>/</kbd>
          </div>
          <div className="side-tools">
            <div className="seg small" role="radiogroup" aria-label="File list layout">
              {(['order', 'tree'] as Mode[]).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => {
                    setMode(m);
                    localStorage.setItem('sift.sideMode', m);
                  }}
                >
                  {m === 'order' ? 'By importance' : 'Folders'}
                </button>
              ))}
            </div>
            <label className="toggle small" title="Hide files you have marked viewed">
              <input type="checkbox" checked={hideViewed} onChange={(e) => setHideViewed(e.target.checked)} />
              <span>Unviewed</span>
            </label>
          </div>
          <div className="side-scroll" ref={scrollRef}>
            <div className="vlist" style={{ height: v.getTotalSize() }}>
              {v.getVirtualItems().map((vi) => {
                const r = rows[vi.index];
                return (
                  <div key={vi.key} className="vi" style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}>
                    {r.kind === 'band' ? (
                      <button className={`band-head band-${r.id}`} onClick={() => r.toggle && setShowNoise(!showNoise)} disabled={!r.toggle}>
                        <span>{r.label}</span>
                        <span className="count">{fmt(r.count)}</span>
                        {r.toggle && <span className="band-toggle">{r.open ? 'Hide' : 'Show'}</span>}
                      </button>
                    ) : r.kind === 'dir' ? (
                      dirRow(r)
                    ) : (
                      fileRow(r)
                    )}
                  </div>
                );
              })}
            </div>
            {!shown.length && <p className="side-empty">{ql || hideViewed ? 'No files match.' : 'No changed files.'}</p>}
          </div>
          <div className="progress" title={`${viewedCount} of ${files.length} files, ${fmt(viewedLines)} of ${fmt(totalLines)} changed lines viewed`}>
            <div className="progress-bar">
              <span style={{ width: `${totalLines ? (viewedLines / totalLines) * 100 : files.length ? (viewedCount / files.length) * 100 : 0}%` }} />
            </div>
            <span>
              {fmt(viewedCount)} of {fmt(files.length)} viewed
            </span>
          </div>
        </>
      )}

      {tab === 'notes' && (
        <>
          <div className="kind-chips">
            <button className={!kindFilter ? 'on' : ''} onClick={() => setKindFilter(null)}>
              All <span className="count">{review.notes.length}</span>
            </button>
            {KIND_ORDER.filter((k) => kindCounts.has(k)).map((k) => (
              <button key={k} className={`k-${k} ${kindFilter === k ? 'on' : ''}`} onClick={() => setKindFilter(kindFilter === k ? null : k)}>
                <i className={`dot k-${k}`} />
                {KIND[k].label} <span className="count">{kindCounts.get(k)}</span>
              </button>
            ))}
          </div>
          <div className="side-scroll">
            <ul className="nlist">
              {notesShown.map((n: ResolvedNote) => (
                <li key={n.id}>
                  <button className={`nrow ${review.acked.includes(n.id) ? 'is-read' : ''}`} onClick={() => jumpToNote(n.id)}>
                    <Stamp kind={n.kind} />
                    <span className="ntitle">{n.title}</span>
                    <span className="nloc">{n.file ? location(n.file, n.line, n.endLine) : 'Whole change'}</span>
                  </button>
                </li>
              ))}
            </ul>
            {!review.notes.length && (
              <p className="side-empty">
                No agent notes yet. Agents add them with <code>sift note</code>.
              </p>
            )}
          </div>
        </>
      )}

      {tab === 'comments' && (
        <>
          <div className="side-scroll">
            <ul className="nlist">
              {review.feedback.map((f) => (
                <li key={f.id}>
                  <button className={`nrow ${f.status === 'resolved' ? 'is-read' : ''}`} onClick={() => jumpToFeedback(f.id)}>
                    <span className={`thread-badge ${f.status}`}>{f.status === 'open' ? 'Open' : 'Resolved'}</span>
                    <span className="ntitle">{plainSnippet(f.body)}</span>
                    <span className="nloc">
                      {f.file ? location(f.file, f.line, f.endLine) : 'General'}
                      {f.replies.some((r) => r.author === 'agent') && ' · agent replied'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {!review.feedback.length && (
              <p className="side-empty">
                Click a line number to leave a comment. The agent picks comments up with <code>sift feedback</code>.
              </p>
            )}
          </div>
          {openComments.length > 0 && (
            <div className="side-foot">
              <button className="btn primary wide" onClick={copyPrompt}>
                {copied ? 'Copied' : 'Copy prompt for the agent'}
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
