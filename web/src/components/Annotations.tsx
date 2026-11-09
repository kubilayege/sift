import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ResolvedFeedback, ResolvedNote } from '../types.ts';
import { api } from '../api.ts';
import { renderMarkdown } from '../markdown.ts';
import { KIND, plainSnippet, timeAgo } from '../model.ts';
import { useReview, type ComposerTarget } from '../state.ts';

export function Markdown({ src, className = '' }: { src: string; className?: string }) {
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />;
}

/** One line of code: syntax tokens (`k` = [len, class, ...]) with the changed span (`e`) emphasised. */
export function Code({ text, k, e }: { text: string; k?: number[]; e?: [number, number] }) {
  if (!text) return <span>{'\u200b'}</span>;
  let segs: [number, number][] = [];
  if (k && k.length) {
    let total = 0;
    for (let i = 0; i < k.length; i += 2) {
      segs.push([k[i], k[i + 1]]);
      total += k[i];
    }
    if (total !== text.length) segs = [[text.length, 0]];
  } else segs = [[text.length, 0]];
  const out: ReactNode[] = [];
  let pos = 0;
  segs.forEach(([len, cls], i) => {
    const start = pos;
    const end = pos + len;
    pos = end;
    const c = cls ? `t${cls}` : undefined;
    const piece = text.slice(start, end);
    if (!e || end <= e[0] || start >= e[1]) {
      out.push(
        <span key={i} className={c}>
          {piece}
        </span>,
      );
      return;
    }
    const a = Math.max(e[0], start) - start;
    const b = Math.min(e[1], end) - start;
    if (a > 0) out.push(<span key={`${i}a`} className={c}>{piece.slice(0, a)}</span>);
    out.push(
      <mark key={`${i}b`} className={c}>
        {piece.slice(a, b)}
      </mark>,
    );
    if (b < piece.length) out.push(<span key={`${i}c`} className={c}>{piece.slice(b)}</span>);
  });
  return <>{out}</>;
}

export function Stamp({ kind }: { kind: ResolvedNote['kind'] }) {
  return (
    <span className={`stamp k-${kind}`} title={KIND[kind].hint}>
      {KIND[kind].label}
    </span>
  );
}

export function location(file?: string, line?: number, endLine?: number) {
  if (!file) return '';
  return `${file}${line ? `:${line}${endLine && endLine !== line ? `–${endLine}` : ''}` : ''}`;
}

const interactive = (t: EventTarget) => t instanceof Element && !!t.closest('a, button, input, textarea, select, summary');

export function NoteCard({ note, showLocation = false, children }: { note: ResolvedNote; showLocation?: boolean; children?: ReactNode }) {
  const { review, currentNoteId, flashId, ack, jumpToNote } = useReview();
  const read = review.acked.includes(note.id);
  const cls = [
    'note',
    `k-${note.kind}`,
    currentNoteId === note.id && 'is-current',
    flashId === note.id && 'is-flash',
    read && 'is-read',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <article
      id={`note-${note.id}`}
      className={cls}
      data-note={note.id}
      // Double-click anywhere on the card (but not on its links and buttons) toggles read.
      onMouseDown={(e) => {
        if (e.detail > 1 && !interactive(e.target)) e.preventDefault(); // no word selection
      }}
      onDoubleClick={(e) => {
        if (!interactive(e.target)) ack([note.id], !read);
      }}
    >
      <header className="note-head">
        <Stamp kind={note.kind} />
        {note.step != null && <span className="note-step">Step {note.step}</span>}
        <h4 className="note-title">{note.title}</h4>
        <button
          className="note-read"
          onClick={() => ack([note.id], !read)}
          title={read ? 'Mark as unread (or double-click the note)' : 'Mark as read (or double-click the note)'}
          aria-pressed={read}
        >
          {read ? 'Read' : 'Mark read'}
        </button>
      </header>
      {note.body && <Markdown src={note.body} className="note-body" />}
      {note.stale && (
        <p className="note-stale">The line this note pointed at has changed since it was written; it is shown here instead.</p>
      )}
      {showLocation && note.file && (
        <button className="note-loc" onClick={() => jumpToNote(note.id)}>
          {location(note.file, note.line, note.endLine)}
          {note.side === 'old' ? ' (removed code)' : ''}
        </button>
      )}
      {children}
    </article>
  );
}

export function Composer({ target }: { target: ComposerTarget }) {
  const { submitFeedback, openComposer } = useReview();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const label = target.line
    ? `Comment on ${target.endLine && target.endLine !== target.line ? `lines ${target.line}–${target.endLine}` : `line ${target.line}`}${target.side === 'old' ? ' (removed code)' : ''}`
    : target.file
      ? `Comment on ${target.file}`
      : 'General comment for the agent';
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await submitFeedback(target, body.trim());
      openComposer(null);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="composer">
      <label className="composer-label" htmlFor="sift-composer">
        {label}
      </label>
      <textarea
        id="sift-composer"
        ref={ref}
        value={body}
        placeholder="What should the agent change or explain? Markdown works."
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === 'Escape') openComposer(null);
          e.stopPropagation();
        }}
        rows={3}
      />
      {err && <p className="error-inline">{err}</p>}
      <div className="composer-actions">
        <span className="hint">⌘↵ to save · Esc to cancel</span>
        <button className="btn ghost" onClick={() => openComposer(null)}>
          Cancel
        </button>
        <button className="btn primary" disabled={!body.trim() || busy} onClick={submit}>
          Save comment
        </button>
      </div>
    </div>
  );
}

export function FeedbackThread({ item, showLocation = false }: { item: ResolvedFeedback; showLocation?: boolean }) {
  const { refresh, flashId, jumpToFeedback } = useReview();
  const [open, setOpen] = useState(item.status === 'open');
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const resolved = item.status === 'resolved';
  const act = (p: Promise<unknown>) => p.then(refresh).catch((e) => alert(e.message));

  if (resolved && !open) {
    return (
      <div id={`fb-${item.id}`} className={`thread is-resolved is-folded ${flashId === item.id ? 'is-flash' : ''}`}>
        <button className="thread-fold" onClick={() => setOpen(true)}>
          <span className="thread-badge resolved">Resolved</span>
          <span className="thread-snippet">{plainSnippet(item.body)}</span>
          {item.replies.length > 0 && <span className="thread-count">{item.replies.length} repl{item.replies.length === 1 ? 'y' : 'ies'}</span>}
        </button>
      </div>
    );
  }
  return (
    <div id={`fb-${item.id}`} className={`thread ${resolved ? 'is-resolved' : ''} ${flashId === item.id ? 'is-flash' : ''}`}>
      <div className="comment by-user">
        <div className="comment-meta">
          <span className="who">You</span>
          <span className="comment-id" title="Agents reference this id">#{item.id}</span>
          <time>{timeAgo(item.createdAt)}</time>
          {resolved && <span className="thread-badge resolved">Resolved</span>}
          {item.stale && <span className="thread-badge">Line moved</span>}
        </div>
        {showLocation && item.file && (
          <button className="note-loc" onClick={() => jumpToFeedback(item.id)}>
            {location(item.file, item.line, item.endLine)}
          </button>
        )}
        <Markdown src={item.body} />
      </div>
      {item.replies.map((r, i) => (
        <div key={i} className={`comment by-${r.author}`}>
          <div className="comment-meta">
            <span className="who">{r.author === 'agent' ? 'Agent' : 'You'}</span>
            <time>{timeAgo(r.createdAt)}</time>
          </div>
          <Markdown src={r.body} />
        </div>
      ))}
      {replying ? (
        <div className="composer small">
          <textarea
            autoFocus
            value={reply}
            rows={2}
            placeholder="Reply…"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setReplying(false);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reply.trim())
                act(api.reply(item.id, reply.trim())).then(() => {
                  setReply('');
                  setReplying(false);
                });
            }}
          />
          <div className="composer-actions">
            <button className="btn ghost" onClick={() => setReplying(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={!reply.trim()}
              onClick={() =>
                act(api.reply(item.id, reply.trim())).then(() => {
                  setReply('');
                  setReplying(false);
                })
              }
            >
              Reply
            </button>
          </div>
        </div>
      ) : (
        <div className="thread-actions">
          <button className="btn link" onClick={() => setReplying(true)}>
            Reply
          </button>
          <button
            className="btn link"
            onClick={() => {
              if (!resolved) setOpen(false);
              act(api.setStatus(item.id, resolved ? 'open' : 'resolved'));
            }}
          >
            {resolved ? 'Reopen' : 'Resolve'}
          </button>
          <button
            className="btn link danger"
            onClick={() => {
              if (confirm('Delete this comment?')) act(api.deleteFeedback(item.id));
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
