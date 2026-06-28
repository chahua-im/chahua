import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

  // The avatar follows the last message's swipe — but only when the group is at
  // rest (avatar settled at the last message). Mutated directly on the DOM via
  // `avatarRef` to avoid re-rendering the whole group (and its N ChatBubbles) on
  // every touchmove frame. `avatarAtRestRef` is the gate; the sentinel's
  // IntersectionObserver flips it (in-view = group bottom visible = at rest).
  const avatarRef = useRef<HTMLDivElement>(null);
  const messageColumnRef = useRef<HTMLDivElement>(null);
  const avatarAtRestRef = useRef(true);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
    };

    compute();
    // Recompute on any size change (reaction added/removed, bubble reflow, new
    // messages appended to the group).
    const ro = new ResizeObserver(compute);
    ro.observe(root);
    return () => ro.disconnect();
  }, [useStickyAvatar]);

  // Track whether the group's bottom is in the viewport. When it is, the sticky
  // avatar has settled at the last message and should slide with that message's
  // swipe. When it isn't (long group, avatar still stuck higher), keep it static.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        avatarAtRestRef.current = entry.isIntersecting;
        // Leaving the rest state: drop any in-flight transform so the avatar
        // snaps back to its sticky (non-swiped) position immediately.
        if (!entry.isIntersecting && avatarRef.current) {
          avatarRef.current.style.transform = '';
          avatarRef.current.style.transition = '';
        }
      },
      // root: null = viewport. The chat scroll surface is viewport-sized.
      { threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  // Every bubble reports its live swipe; SenderGroup mutates the DOM directly
  // (no state) so swiping stays 60fps regardless of group size. Two effects:
  //  - any bubble: raise the message column z-index so it paints over the avatar
  //    while swiping, then restore it so the avatar is tappable at rest;
  //  - only the last bubble (isLast): also drive the floating avatar transform.
  const reportSwipe = useCallback((transformPx: number, animating: boolean, isLast: boolean) => {
    // Raise the message column above the avatar while any bubble is swiping
    // (z 3 > 2) so it paints OVER the avatar. Drop back to CSS default (1) on
    // release so the avatar stays directly tappable at rest. Not gated by
    // avatarAtRestRef: even mid-scroll (avatar stuck elsewhere) the swipe
    // visual should win, and there is no overlap to protect in that state anyway.
    const mc = messageColumnRef.current;
    if (mc) mc.style.zIndex = transformPx !== 0 ? '3' : '';
    // Only the last message's swipe drives the floating avatar transform;
    // non-last bubbles slide over the (stationary) avatar instead of dragging it.
    if (!isLast) return;
    const el = avatarRef.current;
    if (!el || !avatarAtRestRef.current) return;
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
      <div className={containerClass} style={{ bottom: avatarContainerBottom }}>
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
        <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
      </div>
    </div>
  );
}
