import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance, Token } from 'markdown-it';

import { applyMarkdownSubset } from './rules';
import { normalizeMarkdownBeforeParse } from './normalize';

/**
 * markdown-it tuned for chat messages: raw HTML renders as text, bare URLs and
 * single newlines become links / `<br>`, and only the supported subset in
 * rules.ts ever produces tokens. Every parse first runs
 * {@link normalizeMarkdownBeforeParse} so out-of-subset input and marker pairs
 * with stray inner spaces render predictably.
 */
export interface MarkdownEngineOptions {
  html?: boolean;
  breaks?: boolean;
  linkify?: boolean;
}

interface ParseOverridable {
  parse: (src: string, env?: Record<string, unknown>) => Token[];
}

export function createMarkdownEngine(options: MarkdownEngineOptions = {}): MarkdownItInstance {
  const md = new MarkdownIt({
    html: options.html ?? false,
    linkify: options.linkify ?? true,
    breaks: options.breaks ?? true,
    typographer: false,
  });

  applyMarkdownSubset(md);

  const self = md as unknown as ParseOverridable;
  const nativeParse = self.parse.bind(self);
  self.parse = (src: string, env?: Record<string, unknown>): Token[] =>
    nativeParse(normalizeMarkdownBeforeParse(src), env ?? {});

  return md;
}

export const markdownEngine = createMarkdownEngine();
