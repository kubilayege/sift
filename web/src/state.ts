import { createContext, useContext } from 'react';
import type { ResolvedFeedback, ResolvedNote, Review, Side } from './types.ts';

export interface ComposerTarget {
  file?: string;
  side: Side;
  line?: number;
  endLine?: number;
}

export interface ReviewCtx {
  review: Review;
  view: 'unified' | 'split';
  ws: boolean;
  currentNoteId: string | null;
  flashId: string | null;
  composer: ComposerTarget | null;
  notesById: Map<string, ResolvedNote>;
  feedbackById: Map<string, ResolvedFeedback>;
  selectLine: (file: string, side: Side, line: number, extend: boolean) => void;
  openComposer: (t: ComposerTarget | null) => void;
  submitFeedback: (t: ComposerTarget, body: string) => Promise<void>;
  ack: (ids: string[], acked: boolean) => void;
  jumpToNote: (id: string) => void;
  jumpToFile: (path: string) => void;
  jumpToFeedback: (id: string) => void;
  refresh: () => void;
}

export const Ctx = createContext<ReviewCtx | null>(null);

export function useReview(): ReviewCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useReview outside provider');
  return c;
}
