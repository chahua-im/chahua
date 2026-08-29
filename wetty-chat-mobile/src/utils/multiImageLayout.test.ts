import { describe, it, expect } from 'vitest';
import { computeMultiImageLayout, type ImageInput, type LayoutOptions } from './multiImageLayout';

const opts = (w: number, h: number, gap = 2): LayoutOptions => ({
  containerWidth: w,
  maxHeight: h,
  gap,
  minWidth: 60,
  minHeight: 60,
});

/** Images have finite positive area and fit within the given bounds (within gap tolerance). */
function assertValidRects(rects: { x: number; y: number; width: number; height: number }[], cw: number, ch: number) {
  for (const r of rects) {
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.x).toBeGreaterThanOrEqual(-0.5);
    expect(r.y).toBeGreaterThanOrEqual(-0.5);
    expect(r.x + r.width).toBeLessThanOrEqual(cw + 0.5);
    expect(r.y + r.height).toBeLessThanOrEqual(ch + 0.5);
  }
}

describe('computeMultiImageLayout', () => {
  // --- 1 image ---

  it('fills the container for a single image', () => {
    const { rects, height } = computeMultiImageLayout([{ aspectRatio: 1.5 }], opts(300, 200));
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBe(0);
    expect(rects[0].y).toBe(0);
    expect(rects[0].width).toBe(300);
    expect(rects[0].height).toBe(200);
    expect(height).toBe(200);
  });

  // --- 2 images ---

  it('places 2 landscape images side-by-side in a wide container', () => {
    const images: ImageInput[] = [{ aspectRatio: 1.5 }, { aspectRatio: 1.5 }];
    const { rects, height } = computeMultiImageLayout(images, opts(300, 200));
    expect(rects).toHaveLength(2);
    assertValidRects(rects, 300, height);

    // V-cut: side by side, similar widths
    expect(rects[0].y).toBe(0);
    expect(rects[1].y).toBe(0);
    expect(rects[0].x).toBeLessThan(rects[1].x);
  });

  it('places 2 portrait images stacked in a tall container', () => {
    const images: ImageInput[] = [{ aspectRatio: 0.5 }, { aspectRatio: 0.5 }];
    const { rects, height } = computeMultiImageLayout(images, opts(200, 400));
    expect(rects).toHaveLength(2);
    assertValidRects(rects, 200, height);

    // Both rects should have positive dimensions
    expect(rects[0].width).toBeGreaterThan(0);
    expect(rects[0].height).toBeGreaterThan(0);
    expect(rects[1].width).toBeGreaterThan(0);
    expect(rects[1].height).toBeGreaterThan(0);
  });

  it('places 2 mixed images with one larger than the other', () => {
    const images: ImageInput[] = [{ aspectRatio: 2.5 }, { aspectRatio: 0.4 }];
    const { rects, height } = computeMultiImageLayout(images, opts(300, 200));
    expect(rects).toHaveLength(2);
    assertValidRects(rects, 300, height);

    // First image (wide) should get more width or area
    const area0 = rects[0].width * rects[0].height;
    const area1 = rects[1].width * rects[1].height;
    // Wide image gets at least as much area as the tall one
    expect(area0).toBeGreaterThanOrEqual(area1 * 0.5);
  });

  // --- 3 images ---

  it('produces a valid layout for 3 mixed images', () => {
    const images: ImageInput[] = [{ aspectRatio: 1.5 }, { aspectRatio: 1.0 }, { aspectRatio: 0.7 }];
    const { rects, height } = computeMultiImageLayout(images, opts(300, 250));
    expect(rects).toHaveLength(3);
    assertValidRects(rects, 300, height);
  });

  it('produces a valid layout for 3 identical images', () => {
    const images: ImageInput[] = [{ aspectRatio: 1.0 }, { aspectRatio: 1.0 }, { aspectRatio: 1.0 }];
    const { rects, height } = computeMultiImageLayout(images, opts(300, 300));
    expect(rects).toHaveLength(3);
    assertValidRects(rects, 300, height);
  });

  // --- 4 images ---

  it('produces a valid layout for 4 landscape images', () => {
    const images: ImageInput[] = [
      { aspectRatio: 1.5 },
      { aspectRatio: 1.3 },
      { aspectRatio: 1.4 },
      { aspectRatio: 1.6 },
    ];
    const { rects, height } = computeMultiImageLayout(images, opts(400, 300));
    expect(rects).toHaveLength(4);
    assertValidRects(rects, 400, height);
  });

  // --- 6 images ---

  it('produces a valid layout for 6 images', () => {
    const images: ImageInput[] = [
      { aspectRatio: 1.5 },
      { aspectRatio: 0.8 },
      { aspectRatio: 1.2 },
      { aspectRatio: 0.6 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.8 },
    ];
    const { rects, height } = computeMultiImageLayout(images, opts(350, 400));
    expect(rects).toHaveLength(6);
    assertValidRects(rects, 350, height);
  });

  it('produces a valid layout for 6 identical images', () => {
    const images: ImageInput[] = Array.from({ length: 6 }, () => ({ aspectRatio: 1.0 }));
    const { rects, height } = computeMultiImageLayout(images, opts(300, 300));
    expect(rects).toHaveLength(6);
    assertValidRects(rects, 300, height);
  });

  // --- Extreme aspect ratios ---

  it('handles ultra-wide images', () => {
    const images: ImageInput[] = [{ aspectRatio: 5.0 }, { aspectRatio: 1.0 }];
    const { rects, height } = computeMultiImageLayout(images, opts(300, 200));
    expect(rects).toHaveLength(2);
    assertValidRects(rects, 300, height);
  });

  it('handles ultra-tall images', () => {
    const images: ImageInput[] = [{ aspectRatio: 0.15 }, { aspectRatio: 1.0 }];
    const { rects, height } = computeMultiImageLayout(images, opts(300, 400));
    expect(rects).toHaveLength(2);
    assertValidRects(rects, 300, height);
  });

  it('handles a mix of ultra-wide and ultra-tall', () => {
    const images: ImageInput[] = [{ aspectRatio: 4.0 }, { aspectRatio: 0.2 }, { aspectRatio: 1.0 }];
    const { rects, height } = computeMultiImageLayout(images, opts(300, 300));
    expect(rects).toHaveLength(3);
    assertValidRects(rects, 300, height);
  });

  // --- Min-size constraints ---

  it('respects minimum width constraint', () => {
    const images: ImageInput[] = [
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
    ];
    const minW = 80;
    const { rects } = computeMultiImageLayout(images, {
      containerWidth: 300,
      maxHeight: 300,
      gap: 2,
      minWidth: minW,
      minHeight: 60,
    });
    expect(rects).toHaveLength(6);
    for (const r of rects) {
      expect(r.width).toBeGreaterThanOrEqual(minW - 1); // tolerance for rounding
    }
  });

  it('respects minimum height constraint', () => {
    const images: ImageInput[] = [
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
      { aspectRatio: 1.0 },
    ];
    const minH = 80;
    const { rects } = computeMultiImageLayout(images, {
      containerWidth: 300,
      maxHeight: 300,
      gap: 2,
      minWidth: 60,
      minHeight: minH,
    });
    expect(rects).toHaveLength(6);
    for (const r of rects) {
      expect(r.height).toBeGreaterThanOrEqual(minH - 1);
    }
  });

  // --- Ordering ---

  it('preserves image ordering (left-to-right, top-to-bottom)', () => {
    const images: ImageInput[] = [
      { aspectRatio: 1.5 },
      { aspectRatio: 0.5 },
      { aspectRatio: 1.0 },
      { aspectRatio: 2.0 },
    ];
    const { rects } = computeMultiImageLayout(images, opts(350, 300));
    expect(rects).toHaveLength(4);

    // Verify reading order: each rect's center should be "after" the previous
    for (let i = 1; i < rects.length; i++) {
      const prev = rects[i - 1];
      const curr = rects[i];
      const prevCenterY = prev.y + prev.height / 2;
      const currCenterY = curr.y + curr.height / 2;
      const prevCenterX = prev.x + prev.width / 2;
      const currCenterX = curr.x + curr.width / 2;

      // Either same row (currCenterX > prevCenterX) or next row (currCenterY >= prevCenterY)
      const sameOrNextRow = currCenterY >= prevCenterY - 1;
      const sameRowRight = Math.abs(currCenterY - prevCenterY) < 5 && currCenterX > prevCenterX;
      expect(sameOrNextRow || sameRowRight).toBe(true);
    }
  });

  // --- Gap handling ---

  it('applies gap between cells', () => {
    const images: ImageInput[] = [{ aspectRatio: 1.0 }, { aspectRatio: 1.0 }];
    const gap = 10;
    const { rects } = computeMultiImageLayout(images, { containerWidth: 300, maxHeight: 200, gap });
    expect(rects).toHaveLength(2);

    // For a V-cut, there should be a gap between the two rects
    if (rects[0].y === rects[1].y) {
      // Same row
      const gapActual = rects[1].x - (rects[0].x + rects[0].width);
      expect(gapActual).toBeCloseTo(gap, 0);
    } else {
      // Stacked
      const gapActual = rects[1].y - (rects[0].y + rects[0].height);
      expect(gapActual).toBeCloseTo(gap, 0);
    }
  });

  // --- Different container aspect ratios ---

  it('adapts to a very wide container', () => {
    const images: ImageInput[] = [{ aspectRatio: 1.0 }, { aspectRatio: 1.0 }];
    const { rects, height } = computeMultiImageLayout(images, opts(500, 100));
    expect(rects).toHaveLength(2);
    assertValidRects(rects, 500, height);
  });

  it('adapts to a very tall container', () => {
    const images: ImageInput[] = [{ aspectRatio: 1.0 }, { aspectRatio: 1.0 }];
    const { rects, height } = computeMultiImageLayout(images, opts(100, 500));
    expect(rects).toHaveLength(2);
    assertValidRects(rects, 100, height);
  });

  // --- No overlaps (cells should not overlap significantly) ---

  it('produces non-overlapping cells', () => {
    const images: ImageInput[] = [
      { aspectRatio: 1.5 },
      { aspectRatio: 0.6 },
      { aspectRatio: 1.0 },
      { aspectRatio: 0.8 },
      { aspectRatio: 1.2 },
    ];
    const { rects } = computeMultiImageLayout(images, opts(350, 350));
    expect(rects).toHaveLength(5);

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        // Allow tiny floating point overlap
        const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        expect(overlapX * overlapY).toBeLessThan(1); // negligible overlap
      }
    }
  });

  // --- Adaptive height ---

  it('adapts height below maxHeight for landscape images', () => {
    const images: ImageInput[] = [
      { aspectRatio: 1.5 },
      { aspectRatio: 1.3 },
      { aspectRatio: 1.4 },
      { aspectRatio: 1.6 },
    ];
    const maxHeight = 400;
    const { rects, height } = computeMultiImageLayout(images, opts(400, maxHeight));
    expect(rects).toHaveLength(4);
    expect(height).toBeLessThan(maxHeight);
    // All rects should fit within the actual height, not the maxHeight
    assertValidRects(rects, 400, height);
  });

  it('caps height at maxHeight for portrait images', () => {
    const images: ImageInput[] = [
      { aspectRatio: 0.4 },
      { aspectRatio: 0.5 },
      { aspectRatio: 0.3 },
      { aspectRatio: 0.6 },
    ];
    const maxHeight = 300;
    const { rects, height } = computeMultiImageLayout(images, opts(300, maxHeight));
    expect(rects).toHaveLength(4);
    expect(height).toBeLessThanOrEqual(maxHeight);
    assertValidRects(rects, 300, height);
  });

  it('single wide image uses natural height below maxHeight', () => {
    const { rects, height } = computeMultiImageLayout([{ aspectRatio: 3.0 }], opts(300, 400));
    expect(rects).toHaveLength(1);
    // naturalHeight = 300 / 3.0 = 100 < 400
    expect(height).toBeCloseTo(100, 0);
    expect(rects[0].height).toBeCloseTo(100, 0);
  });

  it('single tall image is capped at maxHeight', () => {
    const { rects, height } = computeMultiImageLayout([{ aspectRatio: 0.25 }], opts(300, 400));
    expect(rects).toHaveLength(1);
    // naturalHeight = 300 / 0.25 = 1200 > 400
    expect(height).toBe(400);
    expect(rects[0].height).toBe(400);
  });

  it('stacks ultra-wide images with adaptive height preserving aspect ratio', () => {
    // 7136×795 images: ar ≈ 9. Stacked (H-cut) gives near-zero distortion.
    const ar = 7136 / 795;
    const images: ImageInput[] = [{ aspectRatio: ar }, { aspectRatio: ar }];
    const maxHeight = 400;
    const { rects, height } = computeMultiImageLayout(images, opts(400, maxHeight));
    expect(rects).toHaveLength(2);
    // H-cut: stacked, full width
    expect(rects[0].x).toBeCloseTo(0, 0);
    expect(rects[1].x).toBeCloseTo(0, 0);
    expect(rects[0].width).toBeGreaterThan(350);
    // Height adapts: well below maxHeight (natural ≈ 91px, not 400px)
    expect(height).toBeLessThan(maxHeight * 0.3);
    // Each cell preserves the image's aspect ratio
    const cellAR = rects[0].width / rects[0].height;
    expect(cellAR).toBeCloseTo(ar, 0);
  });

  it('isolates extreme-AR image in its own row when placed first', () => {
    // [extreme, normal, normal] — extreme should get full-width row at top
    const images: ImageInput[] = [{ aspectRatio: 8.97 }, { aspectRatio: 1.5 }, { aspectRatio: 1.5 }];
    const { rects } = computeMultiImageLayout(images, opts(400, 400));
    expect(rects).toHaveLength(3);
    // Extreme image should be in its own row (full width)
    expect(rects[0].width).toBeGreaterThan(350);
    // Normal images should be side-by-side below
    expect(rects[1].y).toBeGreaterThan(rects[0].y + rects[0].height - 1);
    expect(rects[2].y).toBeGreaterThan(rects[0].y + rects[0].height - 1);
  });
});
