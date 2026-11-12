import { markdownEngine } from '../markdown/engine';

/** Match links locally without contacting either the server or the destination. */
export function draftLinkUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of markdownEngine.linkify.match(text) ?? []) {
    if (text[match.lastIndex] === '@') continue;
    if (!/^https:\/\//i.test(match.raw) || /^https:\/\/[^/?#]*@/i.test(match.raw) || match.raw.includes('\\')) continue;
    try {
      const url = new URL(match.url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.hostname.startsWith('[') ||
        /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
        url.href.length > 4096
      )
        continue;
      urls.add(url.href);
    } catch {
      // An incomplete URL is still ordinary draft text.
    }
  }
  return [...urls];
}
