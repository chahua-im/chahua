import { getUnreadCount } from '@/api/chats';
import { getUnreadThreadCount } from '@/api/threads';

type BadgeCapable = {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function setAppBadgeCount(target: BadgeCapable, count: number) {
  return target.setAppBadge?.(count);
}

export function clearAppBadgeCount(target: BadgeCapable) {
  return target.clearAppBadge?.();
}

let latestBadgeSyncRequestId = 0;

export async function syncAppBadgeCount(target: BadgeCapable | undefined = globalThis.navigator): Promise<void> {
  const requestId = ++latestBadgeSyncRequestId;

  try {
    const [chatRes, threadRes] = await Promise.all([getUnreadCount(), getUnreadThreadCount()]);
    if (requestId !== latestBadgeSyncRequestId) return;

    const totalUnread = chatRes.data.unreadCount + threadRes.data.unreadThreadCount;
    if (totalUnread > 0) {
      await setAppBadgeCount(target ?? {}, totalUnread);
      return;
    }

    await clearAppBadgeCount(target ?? {});
  } catch (error) {
    if (requestId !== latestBadgeSyncRequestId) return;
    console.error('Failed to sync app badge', error);
  }
}
