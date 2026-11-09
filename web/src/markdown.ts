import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  let html = cache.get(src);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
    // Links open outside the review.
    html = html.replace(/<a /g, '<a target="_blank" rel="noreferrer" ');
    cache.set(src, html);
  }
  return html;
}
