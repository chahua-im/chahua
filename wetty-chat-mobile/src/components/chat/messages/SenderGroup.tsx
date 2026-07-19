import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { UserAvatar } from '@/components/UserAvatar';
import type { User } from '@/api/messages';
import { SenderSwipeContext } from './SenderSwipeContext';
import styles from './SenderGroup.module.scss';

interface SenderGroupProps {
  /** Whether the group renders the sticky avatar (true when showAllAvatars is off). */
  useStickyAvatar: boolean;
  isSent: boolean;
  sender: User;
  onAvatarClick: (sender: User) => void;
  children: ReactNode;
}

/**
 * Wraps a consecutive run of messages from one sender. The avatar lives in an
 * absolutely-positioned container spanning the whole group; the avatar itself is
 * `position: sticky; bottom`, so it tracks the viewport bottom while the group is
 * in view and rests at the group's last message when settled. Pure CSS — no JS
 * scroll tracking, no handoff logic. Modeled on telegram-tt's SenderGroupContainer.
 *
 * Resting offset: reaction pills render below the last bubble *in flow*, which
 * would otherwise make the avatar rest at pill level. To keep the avatar aligned
 * with the last bubble's bottom, the avatar container's `bottom` is offset by the
 * measured height of everything below the last bubble row (reactions + padding).
 */

// Matches ChatBubble's `.snapBack` transition so the avatar's snap-back stays
// in sync with the bubble's.
const SNAP_BACK_TRANSITION = 'transform 0.2s ease-out';

export function SenderGroup({ useStickyAvatar, isSent, sender, onAvatarClick, children }: SenderGroupProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [avatarContainerBottom, setAvatarContainerBottom] = useState(0);

  // The avatar follows the last message's swipe. Mutated directly on the DOM
  // via `avatarRef` to avoid re-rendering the whole group (and its N
  // ChatBubbles) on every touchmove frame. No rest-gate needed: only the last
  // message can be swiped (it's in the viewport when touched), and when it is,
  // the sticky avatar has already aligned with it — so the transform is always
  // safe to apply.
  const avatarRef = useRef<HTMLDivElement>(null);
  const messageColumnRef = useRef<HTMLDivElement>(null);
  // Tracks whether the avatar offset has been measured against a laid-out
  // container. Until true, the avatar container is hidden (visibility:hidden)
  // so the user never sees the avatar at a wrong resting position when the
  // scroll container briefly has clientHeight=0 (e.g. ChatVirtualScroll's first
  // mount inside IonContent before the web component lays out). Once a real
  // measurement is taken, the avatar becomes visible. This mirrors
  // telegram-tt's approach of rendering the avatar only after layout is stable.
  const [avatarMeasured, setAvatarMeasured] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const compute = () => {
      // The last bubble row in DOM order is the group's last message. Its bottom
      // is where the avatar should rest (excluding any reaction pills below it).
      const bubbleRows = root.querySelectorAll<HTMLElement>('[data-bubble-row]');
      const lastBubbleRow = bubbleRows[bubbleRows.length - 1];
      if (!lastBubbleRow) {
        setAvatarContainerBottom(0);
        return;
      }
      const rootRect = root.getBoundingClientRect();
      // Skip measurement while the container has no layout (clientHeight === 0).
      // The avatar stays hidden (avatarMeasured === false) until a real
      // measurement is possible, avoiding a visible 0 -> correct-value jump.
      if (rootRect.height === 0) return;
      const lastBubbleRect = lastBubbleRow.getBoundingClientRect();
      const tailBelowLastBubble = Math.max(0, rootRect.bottom - lastBubbleRect.bottom);
      // Offset the avatar container so its bottom edge sits exactly at the last
      // bubble's bottom. Combined with the sticky avatar's `bottom: 0`, this makes
      // the avatar rest flush with the last bubble's bottom in every state — short
      // groups (resting/clamped), long groups (stuck while scrolling), and the
      // group-end handoff. A sticky `bottom` gap would only apply while the avatar
      // is "stuck" (long groups mid-scroll), leaving short groups misaligned, so
      // the gap must be 0 for consistent resting alignment.
      setAvatarContainerBottom(Math.max(0, tailBelowLastBubble));
      if (!avatarMeasured) setAvatarMeasured(true);
    };

    compute();
    // Recompute on any size change (reaction added/removed, bubble reflow, new
    // messages appended to the group).
    const ro = new ResizeObserver(compute);
    ro.observe(root);
    return () => ro.disconnect();
  }, [useStickyAvatar, avatarMeasured]);

  // Every bubble reports its live swipe; SenderGroup mutates the DOM directly
  // (no state) so swiping stays 60fps regardless of group size. Two effects:
  //  - any bubble: raise the message column z-index so it paints over the avatar
  //    while swiping, then restore it so the avatar is tappable at rest;
  //  - only the last bubble (isLast): also drive the floating avatar transform.
  const reportSwipe = useCallback((transformPx: number, animating: boolean, isLast: boolean) => {
    // Raise the message column above the avatar while any bubble is swiping
    // (z 3 > 2) so it paints OVER the avatar. Drop back to CSS default (1) on
    // release so the avatar stays directly tappable at rest.
    const messageColumn = messageColumnRef.current;
    if (messageColumn) messageColumn.style.zIndex = transformPx !== 0 ? '3' : '';
    // Only the last message's swipe drives the floating avatar transform;
    // non-last bubbles slide over the (stationary) avatar instead of dragging it.
    if (!isLast) return;
    const el = avatarRef.current;
    if (!el) return;
    el.style.transform = transformPx !== 0 ? `translateX(${transformPx}px)` : '';
    el.style.transition = animating ? SNAP_BACK_TRANSITION : '';
  }, []);

  if (!useStickyAvatar) {
    // showAllAvatars on: every message renders its own inline avatar (handled
    // inside each ChatBubble), so this container adds nothing. The swipe context
    // is null → ChatBubble's reporting noops.
    return <>{children}</>;
  }

  const senderName = sender.name ?? `User ${sender.uid}`;
  const containerClass = `${styles.avatarContainer}${isSent ? ` ${styles.sent}` : ''}`;
  // Received: the message column defaults below the sticky avatar (z 1 < 2) so
  // the avatar is tappable; reportSwipe raises it to z 3 while swiping so the
  // bubble paints OVER the avatar. Sent keeps the avatar on top (sent swipes
  // move the bubble away from the right-side avatar, so no overlap).

  return (
    <div ref={rootRef} className={styles.root}>
      <div
        className={containerClass}
        style={{ bottom: avatarContainerBottom, visibility: avatarMeasured ? undefined : 'hidden' }}
      >
        <UserAvatar
          ref={avatarRef}
          name={senderName}
          avatarUrl={sender.avatarUrl ?? undefined}
          className={styles.avatar}
          onClick={() => onAvatarClick(sender)}
        />
      </div>
      <div
        ref={messageColumnRef}
        className={`${styles.messageColumn}${!isSent ? ` ${styles.messageColumnAbove}` : ''}`}
      >
        <SenderSwipeContext.Provider value={{ reportSwipe }}>{children}</SenderSwipeContext.Provider>
      </div>
    </div>
  );
}
