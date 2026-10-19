import fixtures from './telegram-album-fixtures.json';
import { telegramAlbumLayout } from './telegram-album-layout';

// Golden values are generated from the pinned Java source, independently of this port.
// Regenerate with scripts/telegram-album-reference.py; don't record the implementation's output.
describe('Telegram Android album geometry', () => {
  it.each(fixtures.map((fixture, index) => ({ ...fixture, index })))(
    'matches upstream case $index exactly',
    ({ ratios, environment, positions }) => {
      const actual = telegramAlbumLayout(ratios, environment);
      expect(actual.width).toBe(environment.needShare ? 750 : 800);
      expect(actual.positions.map((p) => [p.minX, p.maxX, p.minY, p.maxY, p.pw, p.ph])).toEqual(positions);
    },
  );
});
