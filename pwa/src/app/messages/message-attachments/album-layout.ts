interface Size {
  width: number;
  height: number;
}

interface Frame extends Size {
  x: number;
  y: number;
}

export function canCrop(source: Size, frame: Size) {
  const ratio = frame.width / frame.height / (source.width / source.height);
  return Math.min(ratio, 1 / ratio) >= 0.8;
}

/** Layout uses metadata only; loading an image or video must not move its neighbours. */
export function albumLayout(sizes: readonly Size[], availableWidth: number, scale = 1) {
  const snap = (value: number) => Math.round(value * scale) / scale;
  const width = Math.floor(availableWidth * scale) / scale;
  const gap = 2;
  const ratios = sizes.map(({ width, height }) => width / height);
  const bounded = ratios.map((ratio) => Math.max(0.75, Math.min(1.8, ratio)));
  const frames: Frame[] = [];
  let y = 0;

  function frame(left: number, top: number, right: number, bottom: number) {
    const x = snap(left);
    const y = snap(top);
    const w = snap(right) - x;
    const h = snap(bottom) - y;
    frames.push({ x, y, width: w, height: h });
  }

  function row(start: number, count: number, proportions = bounded) {
    const sum = proportions.slice(start, start + count).reduce((sum, ratio) => sum + ratio, 0);
    const height = snap((width - gap * (count - 1)) / sum);
    let left = 0;
    for (let i = start; i < start + count; i++) {
      const right = i === start + count - 1 ? width : left + height * proportions[i];
      frame(left, y, right, y + height);
      left = snap(right) + gap;
    }
    y += height + gap;
  }

  function group(start: number, end: number) {
    const count = end - start;
    if (count === 1) {
      const height = snap(Math.min(360, width / ratios[start]));
      frame(0, y, width, y + height);
      y += height + gap;
    } else if (count === 2) {
      if (ratios.slice(start, end).every((ratio) => ratio > 1.4)) {
        row(start, 1, ratios);
        row(start + 1, 1, ratios);
      } else row(start, 2, ratios);
    } else if (count === 3 && ratios[start] < 0.8) {
      const rightRatio = 1 / ratios[start + 1] + 1 / ratios[start + 2];
      const height = snap(Math.min(360, (width - gap + gap / rightRatio) / (ratios[start] + 1 / rightRatio)));
      const right = (height - gap) / rightRatio;
      const left = snap(width - right - gap);
      const middle = snap(y + ((height - gap) * ratios[start + 2]) / (ratios[start + 1] + ratios[start + 2]));
      frame(0, y, left, y + height);
      frame(left + gap, y, width, middle);
      frame(left + gap, middle + gap, width, y + height);
      y += height + gap;
    } else if (count === 3) {
      row(start, 1, ratios);
      row(start + 1, 2, ratios);
    } else if (count === 4) {
      const half = snap((width - gap) / 2);
      frame(0, y, half, y + half);
      frame(half + gap, y, width, y + half);
      frame(0, y + half + gap, half, y + width);
      frame(half + gap, y + half + gap, width, y + width);
      y += width + gap;
    } else {
      // At most nine tiles: enumerate two-/three-item rows and favour balanced, lightly cropped rows.
      let best = { score: Infinity, rows: [] as number[] };
      function choose(index: number, rows: number[], score: number) {
        if (index === end) {
          if (score < best.score) best = { score, rows };
          return;
        }
        for (const count of [2, 3]) {
          if (index + count > end) continue;
          const values = bounded.slice(index, index + count);
          const height = (width - gap * (count - 1)) / values.reduce((a, b) => a + b, 0);
          const crop = values.reduce((sum, ratio, i) => {
            const relative = ratio / ratios[index + i];
            return sum + 1 - Math.min(relative, 1 / relative);
          }, 0);
          const narrow = Math.max(0, 80 - height * Math.min(...values)) / width;
          choose(index + count, [...rows, count], score + (height / width - 0.36) ** 2 + crop * 0.1 + narrow * 0.2);
        }
      }
      choose(start, [], 0);
      for (const count of best.rows) {
        row(start, count);
        start += count;
      }
    }
  }

  // Long screenshots and panoramas keep a full-width frame without reordering the surrounding media.
  let start = 0;
  for (let i = 0; i < ratios.length; i++) {
    if (ratios[i] >= 0.5 && ratios[i] <= 2.5) continue;
    if (i > start) group(start, i);
    group(i, i + 1);
    start = i + 1;
  }
  if (start < sizes.length) group(start, sizes.length);
  return { width, height: y - gap, frames };
}
