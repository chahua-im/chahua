import { telegramAlbumLayout, type TelegramAlbumEnvironment } from './telegram-album-layout';

interface Size {
  width: number;
  height: number;
}

/** Converts Telegram geometry to the measured content width, with a separate intrinsic width.
 * Intrinsic width uses the 420px nominal canvas and never depends on ResizeObserver feedback.
 */
export function albumLayout(
  sizes: readonly Size[],
  availableWidth: number | undefined,
  scale = 1,
  environment: TelegramAlbumEnvironment = {
    displayMin: 360 * scale,
    density: scale,
    outgoing: false,
    needShare: false,
  },
  viewport = { parentWidth: 360, displayHeight: 640 },
) {
  const snap = (value: number) => Math.round(value * scale) / scale;
  const width = availableWidth ?? 420;
  if (!sizes.length) return { width: 0, intrinsicWidth: 0, height: 0, frames: [] };
  // Single media uses the existing PWA preview; Telegram's grouped algorithm starts at two items.
  if (sizes.length === 1) {
    const height = snap(Math.min(360, (width * sizes[0].height) / sizes[0].width));
    return { width, intrinsicWidth: width, height, frames: [{ x: 0, y: 0, width, height }] };
  }
  const plan = telegramAlbumLayout(
    sizes.map((size) => size.width / size.height),
    environment,
  );
  // ChatMessageCell: physical pixels, float multiplication, then ceil per row.
  const maxHeight = Math.fround(Math.max(viewport.parentWidth, viewport.displayHeight) * scale * 0.5);
  const rowGap = snap(2);
  const rowCount = Math.max(...plan.positions.map((position) => position.maxY)) + 1;
  const rowHeights = Array.from({ length: rowCount }, (_, row) =>
    Math.max(
      ...plan.positions
        .filter((position) => position.minY === row && position.maxY === row)
        .map((position) => Math.ceil(Math.fround(maxHeight * position.ph)) / scale),
    ),
  );
  const rowTops = [0];
  for (const height of rowHeights) rowTops.push(rowTops.at(-1)! + height + rowGap);
  const boxes = plan.positions.map((position, index) => {
    const left = plan.positions
      .slice(0, index)
      .filter((other) => other.minY <= position.minY && other.maxY >= position.minY)
      .reduce((sum, other) => sum + other.pw, 0);
    return {
      left,
      right: left + position.pw,
      top: rowTops[position.minY],
      bottom: rowTops[position.maxY + 1] - rowGap,
    };
  });
  const extent = Math.max(...boxes.map((box) => box.right));
  const intrinsicWidth = snap((extent * 420) / plan.width);
  const contentWidth = availableWidth == null ? intrinsicWidth : width;
  const factor = contentWidth / extent;
  const height = rowTops.at(-1)! - rowGap;
  // Use matching 2px gutters; spanning frames include the gaps between their rows.
  const frames = boxes.map((box) => {
    const x = snap(box.left * factor + (box.left > 0 ? 1 : 0));
    const y = snap(box.top);
    const right = box.right === extent ? contentWidth : snap(box.right * factor - 1);
    const bottom = snap(box.bottom);
    return { x, y, width: right - x, height: bottom - y };
  });
  return { width: contentWidth, intrinsicWidth, height: snap(height), frames };
}
