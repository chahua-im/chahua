import type { ListMessagesResponse } from '../../../generated/models';
import type { SnowflakeID } from '../../api/snowflake-id';
import { PageDirection } from '../conversation-store';

export type SelectionEdges = Partial<Record<PageDirection, SnowflakeID>>;

export function findSelectionInterval(
  direction: PageDirection,
  anchor: SnowflakeID | undefined,
  edge: SnowflakeID | undefined,
  page: Pick<ListMessagesResponse, 'messages' | 'olderCursor' | 'newerCursor'> | undefined,
  getIndices: () => ReadonlyMap<SnowflakeID, number>,
) {
  if (anchor == null || edge == null || !page) return;
  const older = direction === PageDirection.Older;
  const [first, last] = older ? [edge, anchor] : [anchor, edge];
  if (first >= last) return;
  // An acknowledged outbox message can be displayed beyond a gap in the loaded history.
  const lower = page.messages[0]?.id;
  const upper = page.messages.at(-1)?.id;
  if (page.olderCursor && (lower == null || first < lower)) return;
  if (page.newerCursor && (upper == null || last > upper)) return;

  const indices = getIndices();
  const firstIndex = indices.get(first);
  const lastIndex = indices.get(last);
  if (firstIndex == null || lastIndex == null) return;
  // The anchor is the outermost selected message, so every entry beyond it is new.
  return older ? { start: firstIndex, end: lastIndex } : { start: firstIndex + 1, end: lastIndex + 1 };
}

export function selectionDirectionAfterScroll(
  current: PageDirection | undefined,
  direction: PageDirection,
  edges: SelectionEdges,
  previousEdges: SelectionEdges,
  reachedEdge: boolean,
  canExtend: (direction: PageDirection, edge: SnowflakeID | undefined) => boolean,
): PageDirection {
  if (current == null || current === direction || !canExtend(current, edges[current])) return direction;

  const edge = edges[direction];
  const previous = previousEdges[direction];
  const farther =
    edge != null && (previous == null || (direction === PageDirection.Older ? edge < previous : edge > previous));
  return (farther || reachedEdge) && canExtend(direction, edge) ? direction : current;
}
