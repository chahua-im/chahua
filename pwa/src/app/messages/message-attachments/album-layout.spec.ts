import { albumLayout } from './album-layout';

const sizes = (ratios: number[]) => ratios.map((ratio) => ({ width: 1000 * ratio, height: 1000 }));

describe('albumLayout', () => {
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

  it('uses screen height or wider chat width independently of album width', () => {
    for (const width of [240, 420]) {
      expect(albumLayout(sizes([0.2, 0.2]), width, 2, undefined, { parentWidth: 360, displayHeight: 800 }).height).toBe(
        400,
      );
      expect(
        albumLayout(sizes([0.2, 0.2]), width, 2, undefined, { parentWidth: 1000, displayHeight: 800 }).height,
      ).toBe(500);
    }
  });

  it('rounds sibling heights separately and includes the 2px gap in spanning frames', () => {
    const layout = albumLayout(sizes([0.45, 0.45, 0.45]), 300, 1, undefined, { parentWidth: 360, displayHeight: 801 });
    // Upstream uses 414/814 and 400/814, not equal halves, at normalized width 800.
    expect(layout.frames.map((frame) => frame.height)).toEqual([403, 204, 197]);
    expect(layout.frames[2].y).toBe(206);
    expect(layout.height).toBe(403);
  });

  it('allows the upstream optimizer to give a panorama its own row', () => {
    const { frames } = albumLayout(sizes([1, 0.2, 1.5, 1.5, 4]), 360);
    expect(frames[1].width).toBeLessThan(360);
    expect(frames[4].width).toBe(360);
  });

  it.each([240, 360, 420])('packs eight phone screenshots into three compact rows at width %s', (width) => {
    const { frames, height } = albumLayout(
      Array.from({ length: 8 }, () => ({ width: 1080, height: 2400 })),
      width,
    );
    expect(frames).toHaveLength(8);
    expect(new Set(frames.map((frame) => frame.y)).size).toBe(3);
    expect(height).toBeGreaterThan(320);
    for (const frame of frames) expect(frame.width).toBeLessThan(width);
  });

  it('bounds pairs of long screenshots while retaining single-image sizing', () => {
    const { frames, height } = albumLayout(sizes([0.2, 0.2]), 360);
    expect(frames[1].y).toBe(0);
    expect(frames[1].x).toBe(frames[0].width + 2);
    expect(height).toBe(320);
    expect(albumLayout(sizes([0.2]), 360).frames[0]).toMatchObject({ width: 360, height: 360 });
  });

  it.each([2, 3, 4])('places %s phone screenshots in a primary-left layout', (count) => {
    const { frames, height } = albumLayout(sizes(Array(count).fill(0.45)), 360);
    expect(frames[0].x).toBe(0);
    expect(frames[0].height).toBe(height);
    const right = frames.slice(1);
    expect(right.every((frame) => frame.x === frames[0].width + 2)).toBe(true);
    expect(right[0].y).toBe(0);
    expect(right.at(-1)!.y + right.at(-1)!.height).toBe(height);
    for (let i = 1; i < right.length; i++) {
      expect(right[i].y).toBe(right[i - 1].y + right[i - 1].height + 2);
    }
  });

  it.each([
    [5, [2, 3]],
    [6, [3, 3]],
    [7, [2, 2, 3]],
    [8, [2, 3, 3]],
    [9, [3, 3, 3]],
  ] as const)('groups %s phone screenshots with fuller rows below', (count, expected) => {
    for (const width of [240, 282.5, 360, 420]) {
      const { frames } = albumLayout(sizes(Array(count).fill(0.45)), width);
      const rows = [...new Set(frames.map((frame) => frame.y))];
      expect(rows.map((y) => frames.filter((frame) => frame.y === y).length)).toEqual(expected);
    }
  });

  it.each([1, 2, 3])('aligns internal edges to physical pixels and fills the exact outer width (scale %s)', (scale) => {
    for (const width of [240, 282.5, 333, 360]) {
      for (let count = 2; count <= 9; count++) {
        const ratios = Array.from({ length: count }, (_, i) => [0.2, 0.45, 1.5, 1, 4][i % 5]);
        const layout = albumLayout(sizes(ratios), width, scale);
        expect(layout.frames).toHaveLength(count);
        expect(layout.width).toBe(width);
        expect(Math.max(...layout.frames.map((frame) => frame.x + frame.width))).toBeCloseTo(layout.width);
        expect(Math.max(...layout.frames.map((frame) => frame.y + frame.height))).toBeCloseTo(layout.height);
        layout.frames.forEach((frame, i) => {
          expect(frame.width).toBeGreaterThan(0);
          expect(frame.height).toBeGreaterThan(0);
          for (const value of [frame.x, frame.y, frame.height])
            expect(value * scale).toBeCloseTo(Math.round(value * scale));
          if (frame.x + frame.width < layout.width)
            expect((frame.x + frame.width) * scale).toBeCloseTo(Math.round((frame.x + frame.width) * scale));
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
