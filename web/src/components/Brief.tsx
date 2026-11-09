import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { ATTENTION_KINDS, KIND_ORDER, fmt, timeAgo } from '../model.ts';
import { useReview } from '../state.ts';
import type { FileEntry, LinesOut, ResolvedNote } from '../types.ts';
import { Code, Composer, FeedbackThread, Markdown, NoteCard, Stamp, location } from './Annotations.tsx';

/** Code the agent pointed at outside the diff: shown as an excerpt under its note. */
function Excerpt({ note }: { note: ResolvedNote }) {
  const { review } = useReview();
  const [out, setOut] = useState<LinesOut | null | undefined>(undefined);
  const rev = note.side === 'old' ? review.baseRev : review.headRev;
  const start = Math.max(1, (note.line ?? 1) - 3);
  const end = (note.endLine ?? note.line ?? 1) + 3;
  useEffect(() => {
    let live = true;
    if (!note.line) return;
    api
      .lines({ rev }, note.file!, [[start, end]])
      .then((o) => live && setOut(o))
      .catch(() => live && setOut(null));
    return () => {
      live = false;
    };
  }, [rev, note.file, start, end, note.line]);
  if (out === null) return <p className="file-msg">{note.file} is not in this version of the code.</p>;
  if (!out || !note.line) return null;
  return (
    <div className="excerpt">
      <div className="excerpt-path">{location(note.file, note.line, note.endLine)}</div>
      <div className="excerpt-code">
        {out.lines.map(([n, s, k]) => {
          const inRange = n >= note.line! && n <= (note.endLine ?? note.line!);
          return (
            <div key={n} className={`ln u ctx ${inRange ? 'has-range' : ''}`} style={{ '--mk': `var(--k-${note.kind})`, '--nw': `${String(end).length + 1.6}ch` } as React.CSSProperties}>
              <span className="num">{n}</span>
              <span className="sign" />
              <span className="code">
                <Code text={s} k={k} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Brief({ files, tour, onStartTour }: { files: FileEntry[]; tour: ResolvedNote[]; onStartTour: () => void }) {
  const { review, jumpToNote, composer, openComposer } = useReview();
  const s = review.session;
  const notes = review.notes;
  const adds = files.reduce((a, f) => a + f.additions, 0);
  const dels = files.reduce((a, f) => a + f.deletions, 0);
  const viewedCount = files.filter((f) => review.viewed[f.path] === f.hash).length;
  const sessionNotes = notes.filter((n) => !n.file);
  const referenced = notes.filter((n) => n.file && !n.inDiff);
  const attention = useMemo(
    () =>
      notes
        .filter((n) => ATTENTION_KINDS.has(n.kind) && n.file && n.inDiff)
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.step ?? 1e9) - (b.step ?? 1e9)),
    [notes],
  );
  const questions = notes.filter((n) => n.kind === 'question').length;
  const general = review.feedback.filter((f) => !f.file);
  const generalComposer = composer && !composer.file ? composer : null;

  return (
    <section className="brief" aria-label="Summary">
      <div className="brief-eyebrow">
        {s ? (
          <>
            <span>Session {s.id}</span>
            {s.agent && <span>{s.agent}</span>}
            <span>started {timeAgo(s.createdAt)}</span>
            <span title={s.base}>baseline {s.base.slice(0, 7)}</span>
            {s.status === 'closed' && <span className="closed">closed</span>}
          </>
        ) : (
          <>
            <span>{review.source.label}</span>
            {review.source.detail && <span>{review.source.detail}</span>}
          </>
        )}
      </div>
      <h1 className="brief-title">{s ? s.title : review.source.label}</h1>
      {s?.summary ? (
        <Markdown src={s.summary} className="brief-summary" />
      ) : s ? (
        <p className="brief-empty">The agent has not written a summary yet. It adds one with <code>sift summary</code>.</p>
      ) : (
        <p className="brief-empty">
          Plain git view, so there is no agent brief. Agent notes on these files still show up inline.
        </p>
      )}

      <dl className="brief-stats">
        <div>
          <dt>Files</dt>
          <dd>{fmt(files.length)}</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd>
            <span className="add">+{fmt(adds)}</span> <span className="del">−{fmt(dels)}</span>
          </dd>
        </div>
        <div>
          <dt>Notes</dt>
          <dd>{notes.length}</dd>
        </div>
        {questions > 0 && (
          <div className="stat-q">
            <dt>Questions for you</dt>
            <dd>{questions}</dd>
          </div>
        )}
        <div>
          <dt>Viewed</dt>
          <dd>
            {fmt(viewedCount)}/{fmt(files.length)}
          </dd>
        </div>
        {tour.length > 0 && (
          <div className="brief-tour">
            <button className="btn primary" onClick={onStartTour}>
              Walk through {tour.length} step{tour.length === 1 ? '' : 's'} <kbd>t</kbd>
            </button>
          </div>
        )}
      </dl>

      {attention.length > 0 && (
        <div className="brief-block">
          <h2 className="brief-h">Needs your attention</h2>
          <ul className="attention">
            {attention.map((n) => (
              <li key={n.id}>
                <button onClick={() => jumpToNote(n.id)} className={review.acked.includes(n.id) ? 'is-read' : ''}>
                  <Stamp kind={n.kind} />
                  <span className="att-title">{n.title}</span>
                  <span className="att-loc">{location(n.file, n.line, n.endLine)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sessionNotes.length > 0 && (
        <div className="brief-block">
          <h2 className="brief-h">From the agent</h2>
          <div className="brief-notes">
            {sessionNotes.map((n) => (
              <NoteCard key={n.id} note={n} />
            ))}
          </div>
        </div>
      )}

      {referenced.length > 0 && (
        <div className="brief-block">
          <h2 className="brief-h">Related code outside this change</h2>
          <div className="brief-notes">
            {referenced.map((n) => (
              <NoteCard key={n.id} note={n}>
                <Excerpt note={n} />
              </NoteCard>
            ))}
          </div>
        </div>
      )}

      <div className="brief-block">
        <div className="brief-h-row">
          <h2 className="brief-h">General comments</h2>
          {!generalComposer && (
            <button className="btn link" onClick={() => openComposer({ side: 'new' })}>
              Add a comment
            </button>
          )}
        </div>
        {general.map((f) => (
          <FeedbackThread key={f.id} item={f} />
        ))}
        {generalComposer && <Composer target={generalComposer} />}
        {!general.length && !generalComposer && (
          <p className="brief-empty small">Comments you leave here or on any line are what the agent reads with <code>sift feedback</code>.</p>
        )}
      </div>
    </section>
  );
}
