/*
 * Telegram Android GroupedMessages.calculate(), media geometry port.
 * Copyright Nikolai Kudashov, 2013-2018. GPL-2.0-or-later.
 * Source: DrKLO/Telegram@f32ffeec763f0bdbf4bec25b52d654f77bff733d,
 * TMessagesProj/src/main/java/org/telegram/messenger/MessageObject.java.
 * Modified 2026-10-19: TypeScript port; Android message/RecyclerView bookkeeping
 * is excluded. Geometry, float arithmetic and candidate ordering are retained.
 */

export interface TelegramAlbumEnvironment {
  /** Shorter display dimension in physical pixels, as in Android displaySize. */
  displayMin: number;
  density: number;
  outgoing: boolean;
  needShare: boolean;
}

export interface TelegramAlbumPosition {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pw: number;
  ph: number;
}

// Java uses float after every arithmetic operation, not JavaScript's double.
const f = Math.fround;
const add = (a: number, b: number) => f(a + b);
const sub = (a: number, b: number) => f(a - b);
const mul = (a: number, b: number) => f(a * b);
const div = (a: number, b: number) => f(a / b);
const { min, max, round, trunc } = Math;

/** Telegram's normalized media geometry, before platform-specific gutters and pixels. */
export function telegramAlbumLayout(ratios: readonly number[], environment: TelegramAlbumEnvironment) {
  const width = environment.needShare ? 750 : 800;
  const height = 814;
  const dp = (value: number) => Math.ceil(mul(environment.density, value));
  const minWidth = trunc(div(dp(120), div(environment.displayMin, width)));
  const padding = trunc(div(dp(40), div(environment.displayMin, width)));
  const minH = div(dp(100), height);
  const r = ratios.map(f);
  const count = r.length;
  const positions: TelegramAlbumPosition[] = [];
  const put = (minX: number, maxX: number, minY: number, maxY: number, pw: number, ph: number) =>
    positions.push({ minX, maxX, minY, maxY, pw, ph: f(ph) });
  if (count < 2) return { width, positions };
  const proportions = r.map((ratio) => (ratio > f(1.2) ? 'w' : ratio < f(0.8) ? 'n' : 'q')).join('');
  // The upstream accumulator deliberately starts at 1, not 0.
  const average = div(r.reduce(add, 1), count);
  const forceCalc = r.some((ratio) => ratio > 2);

  if (!forceCalc && count <= 4) {
    if (count === 2) {
      if (proportions === 'ww' && average > 1.4 * div(width, height) && sub(r[0], r[1]) < 0.2) {
        const h = div(round(min(div(width, r[0]), div(width, r[1]), div(height, 2))), height);
        put(0, 0, 0, 0, width, h);
        put(0, 0, 1, 1, width, h);
      } else if (proportions === 'ww' || proportions === 'qq') {
        const w = trunc(width / 2);
        const h = div(round(min(div(w, r[0]), div(w, r[1]), height)), height);
        put(0, 0, 0, 0, w, h);
        put(1, 1, 0, 0, w, h);
      } else {
        let second = trunc(max(mul(f(0.4), width), round(div(div(width, r[0]), add(div(1, r[0]), div(1, r[1]))))));
        let first = width - second;
        if (first < minWidth) {
          second -= minWidth - first;
          first = minWidth;
        }
        const h = div(min(height, round(min(div(first, r[0]), div(second, r[1])))), height);
        put(0, 0, 0, 0, first, h);
        put(1, 1, 0, 0, second, h);
      }
    } else if (count === 3) {
      if (proportions[0] === 'n') {
        const third = min(mul(height, f(0.5)), round(div(mul(r[1], width), add(r[2], r[1]))));
        const second = sub(height, third);
        const right = trunc(max(minWidth, min(mul(width, f(0.5)), round(min(mul(third, r[2]), mul(second, r[1]))))));
        const left = round(min(add(mul(height, r[0]), padding), width - right));
        put(0, 0, 0, 1, left, 1);
        put(1, 1, 0, 0, right, div(second, height));
        put(0, 1, 1, 1, right, div(third, height));
      } else {
        const first = div(round(min(div(width, r[0]), mul(height, f(0.66)))), height);
        const w = trunc(width / 2);
        // Preserve upstream's normalized first-height subtraction here and in the four-item branch.
        const second = max(minH, div(min(sub(height, first), round(min(div(w, r[1]), div(w, r[2])))), height));
        put(0, 1, 0, 0, width, first);
        put(0, 0, 1, 1, w, second);
        put(1, 1, 1, 1, w, second);
      }
    } else if (proportions[0] === 'w') {
      const h0 = div(round(min(div(width, r[0]), mul(height, f(0.66)))), height);
      let h = f(round(div(width, add(add(r[1], r[2]), r[3]))));
      let w0 = trunc(max(minWidth, min(mul(width, f(0.4)), mul(h, r[1]))));
      let w2 = trunc(max(max(minWidth, mul(width, f(0.33))), mul(h, r[3])));
      let w1 = width - w0 - w2;
      if (w1 < dp(58)) {
        const diff = dp(58) - w1;
        w1 = dp(58);
        w0 -= trunc(diff / 2);
        w2 -= diff - trunc(diff / 2);
      }
      h = max(minH, div(min(sub(height, h0), h), height));
      put(0, 2, 0, 0, width, h0);
      put(0, 0, 1, 1, w0, h);
      put(1, 1, 1, 1, w1, h);
      put(2, 2, 1, 1, w2, h);
    } else {
      const w = max(minWidth, round(div(height, add(add(div(1, r[1]), div(1, r[2])), div(1, r[3])))));
      const h0 = min(f(0.33), div(max(dp(120), div(w, r[1])), height));
      const h1 = min(f(0.33), div(max(dp(120), div(w, r[2])), height));
      const h2 = sub(sub(1, h0), h1);
      const w0 = round(min(add(mul(height, r[0]), padding), width - w));
      put(0, 0, 0, 2, w0, add(add(h0, h1), h2));
      put(1, 1, 0, 0, w, h0);
      put(0, 1, 1, 1, w, h1);
      put(0, 1, 2, 2, w, h2);
    }
  } else {
    const cropped = r.map((ratio) => max(f(0.66667), min(f(1.7), average > f(1.1) ? max(1, ratio) : min(1, ratio))));
    const attempts: { counts: number[]; heights: number[] }[] = [];
    const attempt = (...counts: number[]) => {
      let start = 0;
      const heights = counts.map((count) => {
        const h = div(width, cropped.slice(start, start + count).reduce(add, 0));
        start += count;
        return h;
      });
      attempts.push({ counts, heights });
    };
    // Enumeration order and strict comparison are significant for equal scores.
    for (let first = 1; first < count; first++) {
      const second = count - first;
      if (first <= 3 && second <= 3) attempt(first, second);
    }
    for (let first = 1; first < count - 1; first++) {
      for (let second = 1; second < count - first; second++) {
        const third = count - first - second;
        if (first <= 3 && second <= (average < f(0.85) ? 4 : 3) && third <= 3) attempt(first, second, third);
      }
    }
    for (let first = 1; first < count - 2; first++) {
      for (let second = 1; second < count - first; second++) {
        for (let third = 1; third < count - first - second; third++) {
          const fourth = count - first - second - third;
          if (first <= 3 && second <= 3 && third <= 3 && fourth <= 3) attempt(first, second, third, fourth);
        }
      }
    }
    let optimal: (typeof attempts)[number] | undefined;
    let optimalDiff = 0;
    const maxHeight = trunc(width / 3) * 4;
    for (const candidate of attempts) {
      let diff = Math.abs(sub(candidate.heights.reduce(add, 0), maxHeight));
      if (candidate.counts.some((n, i) => i > 0 && candidate.counts[i - 1] > n)) diff = mul(diff, f(1.2));
      if (min(...candidate.heights) < minWidth) diff = mul(diff, f(1.5));
      if (!optimal || diff < optimalDiff) {
        optimal = candidate;
        optimalDiff = diff;
      }
    }
    if (!optimal) return { width, positions };
    let index = 0;
    for (let row = 0; row < optimal.counts.length; row++) {
      const count = optimal.counts[row];
      const rowStart = index;
      const lineHeight = optimal.heights[row];
      let remaining = width;
      for (let column = 0; column < count; column++) {
        const w = trunc(mul(cropped[index++], lineHeight));
        remaining -= w;
        put(column, column, row, row, w, max(minH, div(lineHeight, height)));
      }
      positions[environment.outgoing ? rowStart : index - 1].pw += remaining;
    }
  }
  return { width, positions };
}
