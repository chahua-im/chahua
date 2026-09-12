import { albumLayout, canCrop } from './album-layout';

const sizes = (ratios: number[]) => ratios.map((ratio) => ({ width: 1000 * ratio, height: 1000 }));

describe('albumLayout', () => {
  it('caps cropping at twenty percent in either direction', () => {
    const square = { width: 100, height: 100 };
    expect(canCrop({ width: 125, height: 100 }, square)).toBe(true);
    expect(canCrop({ width: 126, height: 100 }, square)).toBe(false);
    expect(canCrop({ width: 100, height: 125 }, square)).toBe(true);
    expect(canCrop({ width: 100, height: 126 }, square)).toBe(false);
  });

  it('stacks landscape pairs, places portraits side by side and preserves three-item reading order', () => {
    const wide = albumLayout(sizes([16 / 9, 16 / 9]), 360).frames;
    expect(wide[0].width).toBe(360);
    expect(wide[1].y).toBe(wide[0].height + 2);
    const portrait = albumLayout(sizes([2 / 3, 2 / 3]), 360).frames;
    expect(portrait[1].x).toBe(portrait[0].width + 2);
    expect(portrait[1].y).toBe(0);
    const mixed = albumLayout(sizes([2 / 3, 1.5, 16 / 9]), 360).frames;
    expect(mixed[1].x).toBe(mixed[2].x);
    expect(mixed[2].y).toBe(mixed[1].height + 2);
    expect(mixed[0].height).toBe(mixed[2].y + mixed[2].height);
  });

  it('keeps extreme ratios complete in full-width frames at their original positions', () => {
    const { frames } = albumLayout(sizes([1, 0.2, 1.5, 1.5, 4]), 360);
    expect(frames[1]).toMatchObject({ x: 0, width: 360, height: 360 });
    expect(canCrop(sizes([0.2])[0], frames[1])).toBe(false);
    expect(frames[1].y).toBeGreaterThan(frames[0].y);
    expect(frames[2].y).toBeGreaterThan(frames[1].y);
    expect(frames[4]).toMatchObject({ x: 0, width: 360, height: 90 });
  });

  it.each([1, 2, 3])('keeps all frame edges on physical pixels without gaps at the right edge (scale %s)', (scale) => {
    for (const width of [240, 282.5, 333, 360]) {
      for (let count = 2; count <= 9; count++) {
        const ratios = Array.from({ length: count }, (_, i) => [0.6, 1.5, 1, 2][i % 4]);
        const layout = albumLayout(sizes(ratios), width, scale);
        expect(layout.frames).toHaveLength(count);
        expect(Math.max(...layout.frames.map((frame) => frame.x + frame.width))).toBeCloseTo(layout.width);
        expect(Math.max(...layout.frames.map((frame) => frame.y + frame.height))).toBeCloseTo(layout.height);
        layout.frames.forEach((frame, i) => {
          expect(frame.width).toBeGreaterThan(0);
          expect(frame.height).toBeGreaterThan(0);
          for (const value of [frame.x, frame.y, frame.width, frame.height])
            expect(value * scale).toBeCloseTo(Math.round(value * scale));
          for (const other of layout.frames.slice(i + 1)) {
            const overlapX = Math.min(frame.x + frame.width, other.x + other.width) - Math.max(frame.x, other.x);
            const overlapY = Math.min(frame.y + frame.height, other.y + other.height) - Math.max(frame.y, other.y);
            expect(overlapX <= 0 || overlapY <= 0).toBe(true);
          }
        });
      }
    }
  });
});
