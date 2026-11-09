import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { Brief } from './components/Brief.tsx';
import { Shortcuts, Topbar, TourBar } from './components/Chrome.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Stream, type StreamApi } from './components/Stream.tsx';
import { orderFiles, tourNotes } from './model.ts';
import { Ctx, type ComposerTarget, type ReviewCtx } from './state.ts';
import type { FileEntry, Meta, Review, Side } from './types.ts';

const urlSource = () => new URLSearchParams(location.search).get('source');

function usePersisted<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    const raw = localStorage.getItem(`sift.${key}`);
    if (raw == null) return initial;
    return (typeof initial === 'boolean' ? raw === 'true' : raw) as T;
  });
  return [
    v,
    (nv: T) => {
      localStorage.setItem(`sift.${key}`, String(nv));
      setV(nv);
    },
  ];
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [sourceId, setSourceId] = useState<string>(urlSource() ?? '');
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = usePersisted<'unified' | 'split'>('view', 'unified');
  const [ignoreWs, setIgnoreWs] = usePersisted<boolean>('ignoreWs', false);
  const [live, setLive] = useState<'live' | 'offline' | 'connecting'>('connecting');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [forceLoad, setForceLoad] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [help, setHelp] = useState(false);

  // Held in state (not just a ref) so the virtualized stream re-renders once the element exists.
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const stream = useRef<StreamApi>(null);
  const seenFiles = useRef<{ source: string; paths: Set<string> }>({ source: '', paths: new Set() });
  const reqSeq = useRef(0);

  // ---- data -------------------------------------------------------------------------------

  const loadMeta = useCallback(async () => {
    try {
      const m = await api.meta();
      setMeta(m);
      setSourceId((cur) => cur || m.defaultSource);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const loadReview = useCallback(async () => {
    if (!sourceId) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await api.review(sourceId, ignoreWs);
      if (seq !== reqSeq.current) return;
      setReview(r);
      setError(null);
      // Collapse noise and already-viewed files the first time each one shows up.
      const seen = seenFiles.current;
      if (seen.source !== sourceId) {
        seen.source = sourceId;
        seen.paths = new Set();
      }
      const add: string[] = [];
      for (const f of r.files) {
        if (seen.paths.has(f.path)) continue;
        seen.paths.add(f.path);
        if (f.importance === 'noise' || r.viewed[f.path] === f.hash) add.push(f.path);
      }
      if (add.length) setCollapsed((c) => new Set([...c, ...add]));
    } catch (e: any) {
      if (seq === reqSeq.current) setError(e.message);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [sourceId, ignoreWs]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadReview();
    if (sourceId) {
      const u = new URL(location.href);
      u.searchParams.set('source', sourceId);
      history.replaceState(null, '', u);
    }
  }, [loadReview, sourceId]);

  // Live updates: the server watches the repo and .sift and says when to refetch.
  const loadReviewRef = useRef(loadReview);
  loadReviewRef.current = loadReview;
  useEffect(() => {
    let poll: number | undefined;
    const es = new EventSource('/api/events');
    es.addEventListener('hello', (e) => {
      setLive('live');
      const { watching } = JSON.parse((e as MessageEvent).data);
      if (!watching) poll = window.setInterval(() => loadReviewRef.current(), 4000);
    });
    es.addEventListener('change', (e) => {
      const { kinds } = JSON.parse((e as MessageEvent).data) as { kinds: string[] };
      loadReviewRef.current();
      if (kinds.includes('notes') || kinds.includes('git')) loadMeta();
    });
    es.onerror = () => setLive('offline');
    es.onopen = () => setLive('live');
    return () => {
      es.close();
      clearInterval(poll);
    };
  }, [loadMeta]);

  // ---- derived ----------------------------------------------------------------------------

  const files = useMemo(() => (review ? orderFiles(review.files, review.notes) : []), [review]);
  const tour = useMemo(() => (review ? tourNotes(review.notes, files) : []), [review, files]);
  const notesById = useMemo(() => new Map((review?.notes ?? []).map((n) => [n.id, n])), [review]);
  const feedbackById = useMemo(() => new Map((review?.feedback ?? []).map((f) => [f.id, f])), [review]);

  // ---- navigation -------------------------------------------------------------------------

  const flash = (id: string) => {
    setFlashId(id);
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1600);
  };

  const jumpToFile = useCallback((path: string) => {
    setCollapsed((c) => {
      if (!c.has(path)) return c;
      const n = new Set(c);
      n.delete(path);
      return n;
    });
    setActiveFile(path);
    requestAnimationFrame(() => stream.current?.scrollToFile(path));
  }, []);

  const jumpToNote = useCallback((id: string) => {
    stream.current?.scrollToNote(id);
    flash(id);
  }, []);

  const jumpToFeedback = useCallback((id: string) => {
    stream.current?.scrollToFeedback(id);
    flash(id);
  }, []);

  const goTour = useCallback(
    (i: number) => {
      const n = tour[i];
      if (!n) return;
      setTourIndex(i);
      jumpToNote(n.id);
    },
    [tour, jumpToNote],
  );

  // ---- actions ----------------------------------------------------------------------------

  const toggle = useCallback((path: string, open?: boolean) => {
    setCollapsed((c) => {
      const isOpen = !c.has(path);
      const want = open ?? !isOpen;
      if (want === isOpen) return c;
      const n = new Set(c);
      want ? n.delete(path) : n.add(path);
      return n;
    });
  }, []);

  const setViewed = useCallback((list: FileEntry[], v: boolean) => {
    setReview((r) => {
      if (!r) return r;
      const viewed = { ...r.viewed };
      for (const f of list) v ? (viewed[f.path] = f.hash) : delete viewed[f.path];
      return { ...r, viewed };
    });
    setCollapsed((c) => {
      const n = new Set(c);
      for (const f of list) v ? n.add(f.path) : n.delete(f.path);
      return n;
    });
    api.setViewed(Object.fromEntries(list.map((f) => [f.path, v ? f.hash : null]))).catch((e) => setError(e.message));
  }, []);

  const ack = useCallback((ids: string[], acked: boolean) => {
    setReview((r) => {
      if (!r) return r;
      const s = new Set(r.acked);
      for (const id of ids) acked ? s.add(id) : s.delete(id);
      return { ...r, acked: [...s] };
    });
    api.ack(ids, acked).catch(() => {});
  }, []);

  const selectLine = useCallback((file: string, side: Side, line: number, extend: boolean) => {
    setComposer((cur) => {
      if (line <= 0) return { file, side };
      if (extend && cur && cur.file === file && cur.side === side && cur.line) {
        const a = Math.min(cur.line, line);
        const b = Math.max(cur.endLine ?? cur.line, line);
        return { file, side, line: a, endLine: b === a ? undefined : b };
      }
      return { file, side, line };
    });
  }, []);

  const submitFeedback = useCallback(
    async (t: ComposerTarget, body: string) => {
      if (!review) return;
      await api.addFeedback({ ...t, body, rev: t.side === 'old' ? review.baseRev : review.headRev, session: review.session?.id });
      await loadReview();
    },
    [review, loadReview],
  );

  // ---- keyboard ---------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      // Text fields keep their keys; checkboxes and buttons do not, so arrows still work after a click.
      if (t instanceof Element && t.closest('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = activeFile ? files.findIndex((f) => f.path === activeFile) : -1;
      const cur = idx >= 0 ? files[idx] : null;
      const isViewed = (f: FileEntry) => review?.viewed[f.path] === f.hash;
      switch (e.key) {
        case 'j':
          if (files[idx + 1]) jumpToFile(files[idx + 1].path);
          break;
        case 'k':
          if (idx > 0) jumpToFile(files[idx - 1].path);
          else stream.current?.top();
          break;
        case 'ArrowRight':
        case 'ArrowLeft': {
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          if (e.shiftKey) {
            if (dir > 0 ? files[idx + 1] : idx > 0) jumpToFile(files[idx + dir].path);
            else if (dir < 0) stream.current?.top();
          } else if (tourIndex != null) {
            const i = tourIndex + dir;
            if (i >= 0 && i < tour.length) goTour(i);
          } else stream.current?.step(dir);
          break;
        }
        case ']':
          stream.current?.hunk(1);
          break;
        case '[':
          stream.current?.hunk(-1);
          break;
        case 'n':
          if (tour.length) goTour(tourIndex == null ? 0 : Math.min(tour.length - 1, tourIndex + 1));
          break;
        case 'p':
          if (tour.length && tourIndex != null) goTour(Math.max(0, tourIndex - 1));
          break;
        case 't':
          if (tourIndex != null) setTourIndex(null);
          else if (tour.length) goTour(0);
          break;
        case 'v':
          if (cur) {
            const was = isViewed(cur);
            setViewed([cur], !was);
            if (!was) {
              const next = files.slice(idx + 1).find((f) => !isViewed(f)) ?? files.find((f) => f !== cur && !isViewed(f));
              if (next) jumpToFile(next.path);
            }
          }
          break;
        case 'u': {
          const next = files.slice(idx + 1).find((f) => !isViewed(f)) ?? files.find((f) => !isViewed(f));
          if (next) jumpToFile(next.path);
          break;
        }
        case 'o':
          if (cur) toggle(cur.path);
          break;
        case 'O': {
          const anyOpen = files.some((f) => !collapsed.has(f.path));
          setCollapsed(anyOpen ? new Set(files.map((f) => f.path)) : new Set());
          break;
        }
        case 's':
          setView(view === 'unified' ? 'split' : 'unified');
          break;
        case 'w':
          setIgnoreWs(!ignoreWs);
          break;
        case 'c':
          if (cur) {
            toggle(cur.path, true);
            setComposer({ file: cur.path, side: 'new' });
          } else setComposer({ side: 'new' });
          break;
        case '/':
          filterRef.current?.focus();
          break;
        case '?':
          setHelp((h) => !h);
          break;
        case 'Escape':
          if (help) setHelp(false);
          else if (composer) setComposer(null);
          else if (tourIndex != null) setTourIndex(null);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeFile, files, tour, tourIndex, review, view, ignoreWs, composer, help, collapsed, goTour, jumpToFile, setViewed, setView, setIgnoreWs, toggle]);

  // ---- render -----------------------------------------------------------------------------

  const ctx: ReviewCtx | null = review
    ? {
        review,
        view,
        ws: ignoreWs,
        currentNoteId: tourIndex != null ? (tour[tourIndex]?.id ?? null) : null,
        flashId,
        composer,
        notesById,
        feedbackById,
        selectLine,
        openComposer: setComposer,
        submitFeedback,
        ack,
        jumpToNote,
        jumpToFile,
        jumpToFeedback,
        refresh: loadReview,
      }
    : null;

  return (
    <div className={`app ${tourIndex != null ? 'in-tour' : ''}`}>
      <Topbar
        meta={meta}
        sourceId={sourceId}
        onSource={(id) => {
          setTourIndex(null);
          setComposer(null);
          setSourceId(id);
          stream.current?.top();
        }}
        view={view}
        onView={setView}
        ignoreWs={ignoreWs}
        onIgnoreWs={setIgnoreWs}
        live={live}
        loading={loading}
        tookMs={review?.tookMs}
        onHelp={() => setHelp(true)}
      />
      {error && (
        <div className="banner error toast" role="alert">
          {error}
          {sourceId !== 'working' && (
            <button className="btn link" onClick={() => setSourceId('working')}>
              Show uncommitted changes
            </button>
          )}
          <button className="icon-btn" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {ctx ? (
        <Ctx.Provider value={ctx}>
          <div className="body">
            <Sidebar files={files} activeFile={activeFile} filterRef={filterRef} onViewed={setViewed} />
            <main className="main" ref={setMainEl}>
              <div className="column">
                <Stream
                  files={files}
                  collapsed={collapsed}
                  forceLoad={forceLoad}
                  onToggle={toggle}
                  onForceLoad={(p) => setForceLoad((s) => new Set([...s, p]))}
                  onViewed={(f, v) => setViewed([f], v)}
                  onActiveFile={setActiveFile}
                  brief={<Brief files={files} tour={tour} onStartTour={() => goTour(0)} />}
                  emptyText={
                    review!.source.kind === 'session'
                      ? 'The working tree matches the session baseline. Changes appear here as the agent edits files.'
                      : 'Pick another view from the menu at the top, or start an agent session with sift begin.'
                  }
                  scrollEl={mainEl}
                  apiRef={stream}
                />
              </div>
            </main>
          </div>
          {tourIndex != null && <TourBar notes={tour} index={tourIndex} onGo={goTour} onClose={() => setTourIndex(null)} />}
        </Ctx.Provider>
      ) : (
        <div className="boot">{!error && <p className="boot-msg">Reading the repository…</p>}</div>
      )}
      {help && <Shortcuts onClose={() => setHelp(false)} />}
    </div>
  );
}
