/** A `[start, end)` region of the source. */
export interface TextRegion {
  start: number;
  end: number;
}

/**
 * Finds the source regions Markdown treats as code (fenced blocks and same-line
 * inline code spans). Mentions inside those regions must NOT be carved into
 * placeholders: code renders verbatim, so carving would erase the mention text.
 */
export function findCodeRegions(source: string): TextRegion[] {
  const regions: TextRegion[] = [];
  const length = source.length;

  const startsLine = (pos: number): boolean => {
    if (pos === 0) return true;
    const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
    return pos - lineStart <= 3 && source.slice(lineStart, pos).trim() === '';
  };

  let pos = 0;
  while (pos < length) {
    const ch = source[pos];
    if (ch !== '`' && ch !== '~') {
      pos += 1;
      continue;
    }
    let run = 1;
    while (pos + run < length && source[pos + run] === ch) run += 1;

    if (run >= 3 && startsLine(pos)) {
      // Fenced code block — scan for a closing fence of the same char.
      let scan = source.indexOf('\n', pos + run);
      let end = -1;
      while (scan !== -1) {
        const lineStart = scan + 1;
        let k = lineStart;
        while (k < length && source[k] === ' ') k += 1;
        if (k - lineStart <= 3 && source[k] === ch) {
          let closeRun = 1;
          while (k + closeRun < length && source[k + closeRun] === ch) closeRun += 1;
          if (closeRun >= run) {
            end = k + closeRun;
            break;
          }
        }
        scan = source.indexOf('\n', scan + 1);
      }
      regions.push({ start: pos, end: end === -1 ? length : end });
      pos = end === -1 ? length : end;
      continue;
    }

    if (ch === '`') {
      // Inline code span — the same tick run must close on the same line.
      const lineEnd = source.indexOf('\n', pos + run);
      const lineLimit = lineEnd === -1 ? length : lineEnd;
      let close = -1;
      for (let k = pos + run; k + run <= lineLimit; k += 1) {
        if (source[k] === '`') {
          let inner = 1;
          while (k + inner < length && source[k + inner] === '`') inner += 1;
          if (inner === run) {
            close = k;
            break;
          }
        }
      }
      if (close !== -1) {
        regions.push({ start: pos, end: close + run });
        pos = close + run;
        continue;
      }
    }
    pos += run;
  }
  return regions;
}
