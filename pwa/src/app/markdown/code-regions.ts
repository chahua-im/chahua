import MarkdownIt from 'markdown-it';
import { applyMarkdownSubset } from './rules';

/** A `[start, end)` region of the original source. */
export interface TextRegion {
  start: number;
  end: number;
}

// No whitespace normalization here: its caller needs the original offsets.
const regionEngine = new MarkdownIt();
applyMarkdownSubset(regionEngine);
regionEngine.core.ruler.enableOnly(['normalize', 'block']);

/** Finds fences and inline code within the same block boundaries as the renderer. */
export function findCodeRegions(source: string): TextRegion[] {
  const regions: TextRegion[] = [];
  const lineStarts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    lineStarts.push(match.index + match[0].length);
  }
  for (const token of regionEngine.parse(source, {})) {
    if (!token.map) continue;
    const start = lineStarts[token.map[0]];
    const end = lineStarts[token.map[1]] ?? source.length;
    if (token.type === 'fence') {
      regions.push({ start, end });
    } else if (token.type === 'inline') {
      // Backticks may cross soft line breaks, but never paragraph/block boundaries.
      let pos = start;
      while (pos < end) {
        if (source[pos] === '\\') {
          pos += 2;
          continue;
        }
        if (source[pos] !== '`') {
          pos++;
          continue;
        }
        let openEnd = pos + 1;
        while (openEnd < end && source[openEnd] === '`') openEnd++;
        const length = openEnd - pos;
        let scan = openEnd;
        let closeEnd = -1;
        while (scan < end) {
          if (source[scan] !== '`') {
            scan++;
            continue;
          }
          let runEnd = scan + 1;
          while (runEnd < end && source[runEnd] === '`') runEnd++;
          if (runEnd - scan === length) {
            closeEnd = runEnd;
            break;
          }
          scan = runEnd;
        }
        if (closeEnd !== -1) regions.push({ start: pos, end: closeEnd });
        pos = closeEnd === -1 ? openEnd : closeEnd;
      }
    }
  }
  return regions;
}
