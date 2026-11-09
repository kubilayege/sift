// Mirrors the JSON the Rust server sends (src/types.rs, src/engine.rs).

export const NOTE_KINDS = ['important', 'why', 'risk', 'question', 'verify', 'todo', 'info'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const IMPORTANCE = ['critical', 'high', 'normal', 'low', 'noise'] as const;
export type Importance = (typeof IMPORTANCE)[number];

export type Side = 'new' | 'old';

export interface Note {
  id: string;
  session: string;
  kind: NoteKind;
  title: string;
  body?: string;
  file?: string;
  line?: number;
  endLine?: number;
  side: Side;
  anchor?: string;
  step?: number;
  createdAt: string;
}

export interface ResolvedNote extends Note {
  stale?: boolean;
  inDiff: boolean;
}

export interface FileMeta {
  importance?: Importance;
  summary?: string;
}

export interface Session {
  id: string;
  title: string;
  summary?: string;
  agent?: string;
  base: string;
  baseHead?: string;
  createdAt: string;
  updatedAt: string;
  status: 'open' | 'closed';
  files: Record<string, FileMeta>;
  noise: string[];
}

export interface Reply {
  author: 'agent' | 'user';
  body: string;
  createdAt: string;
}

export interface Feedback {
  id: string;
  file?: string;
  line?: number;
  endLine?: number;
  side: Side;
  anchor?: string;
  body: string;
  status: 'open' | 'resolved';
  session?: string;
  createdAt: string;
  replies: Reply[];
}

export interface ResolvedFeedback extends Feedback {
  stale?: boolean;
  inDiff: boolean;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

/** A changed file. Its hunks come separately from /api/diff. */
export interface FileEntry {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  /** Rendered diff lines (context included) and hunk count, to size the file before it loads. */
  rows: number;
  hunks: number;
  oldLines: number;
  newLines: number;
  oldBlob?: string;
  newBlob?: string;
  hash: string;
  importance: Importance;
  importanceSource: 'agent' | 'auto' | 'default';
  summary?: string;
  large: boolean;
}

export type LineType = ' ' | '+' | '-';

export interface DiffLine {
  t: LineType;
  s: string;
  o?: number;
  n?: number;
  /** Changed span (UTF-16 offsets). */
  e?: [number, number];
  /** Tokens: [len, class, len, class, ...] */
  k?: number[];
}

export interface Hunk {
  os: number;
  ns: number;
  ol: number;
  nl: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffOut {
  hunks: Hunk[];
  oldLines: number;
  newLines: number;
  binary: boolean;
  tooLarge: boolean;
}

export interface LinesOut {
  blob: string;
  total: number;
  lines: [number, string, number[]][];
}

export type SourceKind = 'session' | 'working' | 'staged' | 'branch' | 'commit' | 'ref';

export interface SourceOption {
  id: string;
  kind: SourceKind;
  label: string;
  detail?: string;
}

export interface Meta {
  repo: string;
  root: string;
  branch: string | null;
  head: string | null;
  sources: SourceOption[];
  defaultSource: string;
  sessions: Session[];
}

export interface Review {
  source: SourceOption;
  baseRev: string;
  headRev: string;
  files: FileEntry[];
  notes: ResolvedNote[];
  feedback: ResolvedFeedback[];
  session?: Session;
  viewed: Record<string, string>;
  acked: string[];
  generatedAt: string;
  ignoreWhitespace: boolean;
  tookMs: number;
}
