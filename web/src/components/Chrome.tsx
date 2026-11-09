import type { Meta, ResolvedNote } from '../types.ts';
import { location, Stamp } from './Annotations.tsx';

interface TopbarProps {
  meta: Meta | null;
  sourceId: string;
  onSource: (id: string) => void;
  view: 'unified' | 'split';
  onView: (v: 'unified' | 'split') => void;
  ignoreWs: boolean;
  onIgnoreWs: (v: boolean) => void;
  live: 'live' | 'offline' | 'connecting';
  loading: boolean;
  tookMs?: number;
  onHelp: () => void;
}

export function Topbar(p: TopbarProps) {
  const sessions = p.meta?.sources.filter((s) => s.kind === 'session') ?? [];
  const git = p.meta?.sources.filter((s) => s.kind !== 'session') ?? [];
  const known = p.meta?.sources.some((s) => s.id === p.sourceId);
  return (
    <header className="topbar">
      <div className="brand" aria-label="Sift">
        <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden>
          <path d="M6 9h20M6 16h13M6 23h7" stroke="var(--k-important)" strokeWidth="3.2" strokeLinecap="round" />
        </svg>
        <span>sift</span>
      </div>
      <div className="repo">
        <span className="repo-name">{p.meta?.repo ?? '…'}</span>
        {p.meta?.branch && <span className="repo-branch">{p.meta.branch}</span>}
      </div>
      <label className="source">
        <span className="sr-only">Reviewing</span>
        <select
          value={p.sourceId}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__ref') {
              const ref = prompt('Compare the working tree against which revision? (branch, tag, or commit)');
              if (ref?.trim()) p.onSource(`ref:${ref.trim()}`);
              return;
            }
            if (v === '__commit') {
              const ref = prompt('Show which commit?');
              if (ref?.trim()) p.onSource(`commit:${ref.trim()}`);
              return;
            }
            p.onSource(v);
          }}
        >
          {sessions.length > 0 && (
            <optgroup label="Agent sessions">
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.detail ? ` — ${s.detail}` : ''}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Git">
            {git.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
                {s.detail && s.kind === 'commit' ? ` — ${s.detail.slice(0, 60)}` : ''}
              </option>
            ))}
            {!known && p.sourceId && <option value={p.sourceId}>{p.sourceId.replace(/^(\w+):/, '$1 ')}</option>}
            <option value="__ref">Compare with a revision…</option>
            <option value="__commit">Show a commit…</option>
          </optgroup>
        </select>
      </label>
      <span className="top-spacer" />
      <span
        className={`live is-${p.live}`}
        title={`${p.live === 'live' ? 'Updates as files change' : 'Not receiving updates'}${p.tookMs != null ? ` · last refresh took ${p.tookMs} ms` : ''}`}
      >
        <i />
        {p.loading ? 'Updating' : p.live === 'live' ? 'Live' : p.live === 'connecting' ? 'Connecting' : 'Offline'}
      </span>
      <label className="toggle" title="Hide whitespace-only changes (w)">
        <input type="checkbox" checked={p.ignoreWs} onChange={(e) => p.onIgnoreWs(e.target.checked)} />
        <span>Hide whitespace</span>
      </label>
      <div className="seg" role="radiogroup" aria-label="Diff layout">
        <button role="radio" aria-checked={p.view === 'unified'} onClick={() => p.onView('unified')}>
          Unified
        </button>
        <button role="radio" aria-checked={p.view === 'split'} onClick={() => p.onView('split')}>
          Split
        </button>
      </div>
      <button className="icon-btn" onClick={p.onHelp} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        ?
      </button>
    </header>
  );
}

export function TourBar({
  notes,
  index,
  onGo,
  onClose,
}: {
  notes: ResolvedNote[];
  index: number;
  onGo: (i: number) => void;
  onClose: () => void;
}) {
  const n = notes[index];
  if (!n) return null;
  return (
    <div className="tourbar" role="region" aria-label="Walkthrough">
      <span className="tour-count">
        {index + 1}
        <span>/{notes.length}</span>
      </span>
      <Stamp kind={n.kind} />
      <div className="tour-text">
        <span className="tour-title">{n.title}</span>
        <span className="tour-loc">{n.file ? location(n.file, n.line, n.endLine) : 'Whole change'}</span>
      </div>
      <button className="btn ghost" disabled={index === 0} onClick={() => onGo(index - 1)} title="Previous (← or p)">
        ← Prev
      </button>
      <button className="btn primary" onClick={() => (index === notes.length - 1 ? onClose() : onGo(index + 1))} title="Next (→ or n)">
        {index === notes.length - 1 ? 'Finish' : 'Next →'}
      </button>
      <button className="icon-btn" onClick={onClose} aria-label="End walkthrough" title="End walkthrough (Esc)">
        ×
      </button>
    </div>
  );
}

const KEYS: [string, string][] = [
  ['← / →', 'Previous / next stop: change, note, comment. Steps the walkthrough while it is open'],
  ['⇧← / ⇧→', 'Previous / next file'],
  ['j / k', 'Next / previous file'],
  ['] / [', 'Next / previous change'],
  ['u', 'Jump to the next unviewed file'],
  ['n / p', 'Next / previous note (walkthrough)'],
  ['t', 'Start or stop the walkthrough'],
  ['v', 'Mark current file viewed, go to the next unviewed'],
  ['o / O', 'Collapse current file / all files'],
  ['s', 'Toggle unified / split'],
  ['w', 'Toggle hide whitespace'],
  ['/', 'Filter files'],
  ['c', 'Comment on the current file'],
  ['Esc', 'Close comment box, walkthrough, or this panel'],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-modal aria-label="Keyboard shortcuts">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard</h2>
        <dl className="keys">
          {KEYS.map(([k, d]) => (
            <div key={k}>
              <dt>
                {k.split(' / ').map((x, i) => (
                  <span key={x}>
                    {i > 0 && ' / '}
                    <kbd>{x}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <p className="sheet-foot">Click a line number to comment on it; shift-click another to cover a range.</p>
      </div>
    </div>
  );
}
