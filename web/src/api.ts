import { useSyncExternalStore } from 'react';
import type { DiffOut, Feedback, FileEntry, LinesOut, Meta, Review, Side } from './types.ts';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as T;
}

const q = encodeURIComponent;

export const api = {
  meta: () => req<Meta>('/api/meta'),
  review: (source: string, ws: boolean) => req<Review>(`/api/review?source=${q(source)}${ws ? '&ws=1' : ''}`),
  lines: (spec: { blob?: string; rev?: string }, path: string, ranges: [number, number][]) =>
    req<LinesOut | null>(
      `/api/lines?${spec.blob ? `blob=${spec.blob}` : `rev=${spec.rev}`}&path=${q(path)}&ranges=${ranges.map(([a, b]) => `${a}-${b}`).join(',')}`,
    ),
  addFeedback: (b: { file?: string; line?: number; endLine?: number; side: Side; body: string; rev?: string; session?: string }) =>
    req<Feedback>('/api/feedback', { method: 'POST', body: JSON.stringify(b) }),
  reply: (id: string, body: string) => req(`/api/feedback/${id}/reply`, { method: 'POST', body: JSON.stringify({ body }) }),
  setStatus: (id: string, status: 'open' | 'resolved') =>
    req(`/api/feedback/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  deleteFeedback: (id: string) => req(`/api/feedback/${id}`, { method: 'DELETE' }),
  setViewed: (files: Record<string, string | null>) =>
    req<{ viewed: Record<string, string> }>('/api/viewed', { method: 'POST', body: JSON.stringify({ files }) }),
  ack: (ids: string[], acked: boolean) => req<{ acked: string[] }>('/api/ack', { method: 'POST', body: JSON.stringify({ ids, acked }) }),
};

// ---- per-file content -------------------------------------------------------------------
//
// Diffs and context lines are content-addressed (blob ids), so they are fetched once, kept for the
// session and shared across live reloads. A small queue keeps scrolling through thousands of files
// from flooding the server; the most recently requested files go first.

export const diffKey = (f: FileEntry, ws: boolean) => `${f.oldBlob ?? ''}|${f.newBlob ?? ''}|${ws ? 1 : 0}`;

type Line = [string, number[]];

class ContentStore {
  private diffs = new Map<string, DiffOut | Error>();
  private inflight = new Set<string>();
  private queue: { key: string; url: string }[] = [];
  private active = 0;
  private lines = new Map<string, Map<number, Line>>();
  private blobVer = new Map<string, number>();
  private linesInflight = new Set<string>();
  private listeners = new Set<() => void>();
  version = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }
  private scheduled = false;
  private bumpSoon() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.bump();
    });
  }

  diff(f: FileEntry, ws: boolean): DiffOut | Error | undefined {
    return this.diffs.get(diffKey(f, ws));
  }

  requestDiff(f: FileEntry, ws: boolean) {
    const key = diffKey(f, ws);
    if (this.diffs.has(key) || this.inflight.has(key)) return;
    if (!f.oldBlob && !f.newBlob) return;
    this.inflight.add(key);
    const url = `/api/diff?a=${f.oldBlob ?? ''}&b=${f.newBlob ?? ''}&path=${q(f.path)}${ws ? '&ws=1' : ''}`;
    this.queue.push({ key, url });
    this.pump();
  }

  private pump() {
    while (this.active < 6 && this.queue.length) {
      const { key, url } = this.queue.pop()!;
      this.active++;
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Could not load this diff (${r.status})`))))
        .then(
          (d: DiffOut) => this.diffs.set(key, d),
          (e: Error) => this.diffs.set(key, e),
        )
        .finally(() => {
          this.inflight.delete(key);
          this.active--;
          this.bumpSoon();
          this.pump();
        });
    }
  }

  /** Changes whenever more context lines of `blob` arrive. */
  linesVersion(blob: string | undefined) {
    return blob ? (this.blobVer.get(blob) ?? 0) : 0;
  }

  line(blob: string, n: number): Line | undefined {
    return this.lines.get(blob)?.get(n);
  }

  hasLines(blob: string, a: number, b: number) {
    const m = this.lines.get(blob);
    if (!m) return false;
    for (let i = a; i <= b; i++) if (!m.has(i)) return false;
    return true;
  }

  async requestLines(blob: string, path: string, ranges: [number, number][]) {
    const need = ranges.filter(([a, b]) => b >= a && !this.hasLines(blob, a, b));
    if (!need.length) return;
    const key = `${blob}:${need.map((r) => r.join('-')).join(',')}`;
    if (this.linesInflight.has(key)) return;
    this.linesInflight.add(key);
    try {
      const out = await api.lines({ blob }, path, need);
      if (!out) return;
      let m = this.lines.get(blob);
      if (!m) this.lines.set(blob, (m = new Map()));
      for (const [n, s, k] of out.lines) m.set(n, [s, k]);
      this.blobVer.set(blob, (this.blobVer.get(blob) ?? 0) + 1);
      this.bump();
    } finally {
      this.linesInflight.delete(key);
    }
  }
}

export const content = new ContentStore();

/** Re-render when diffs or context lines arrive. */
export function useContentVersion() {
  return useSyncExternalStore(content.subscribe, () => content.version);
}
