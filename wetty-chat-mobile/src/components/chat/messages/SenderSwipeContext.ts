import { createContext } from 'react';

/**
 * Reports the live swipe transform of any message bubble in the group up to the
 * SenderGroup. Two effects, both driven by the bubble's signed translateX:
 *
 *  1. The group raises its message column z-index while any bubble is swiping
 *     (z 3 > avatar 2) so the bubble paints OVER the sticky avatar, then drops
 *     it back to the CSS default (1) on release so the avatar stays tappable.
 *  2. Only the LAST message also drives the floating avatar's horizontal transform
 *     — the avatar slides together with that bubble, but only when the group is
 *     at rest (avatar aligned with the last message). Non-last bubbles slide over
 *     the stationary avatar instead of dragging it.
 *
 * `transformPx` is the already-signed translateX (offset * swipeSign), so the
 * avatar mirrors the bubble exactly. `animating` mirrors the `.snapBack` flag so
 * the snap-back transition stays in sync. `isLastInGroup` selects effect (2).
 * When the context is null (search / read-only / showAllAvatars inline mode)
 * ChatBubble's reporting is a no-op.
 */
export interface SenderSwipeContextValue {
  reportSwipe: (transformPx: number, animating: boolean, isLastInGroup: boolean) => void;
}

export const SenderSwipeContext = createContext<SenderSwipeContextValue | null>(null);
