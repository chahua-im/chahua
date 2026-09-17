import { IonBadge, IonLabel, IonSegment, IonSegmentButton } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { useSelector } from 'react-redux';
import { formatUnreadBadge } from '@/utils/unreadBadge';
import { selectPendingIncomingCount } from '@/store/socialSlice';
import styles from './ChatListSegment.module.scss';

import type { ChatListTab } from './chatListTabs';

interface ChatListSegmentProps {
  value: ChatListTab;
  onChange: (tab: ChatListTab) => void;
  messagesUnreadCount: number;
  groupsUnreadCount: number;
  friendsUnreadCount: number;
  threadsUnreadCount: number;
  /** Whether any chat/thread in the segment's scope has unread mentions (overrides the numeric badge). */
  messagesHasMention?: boolean;
  groupsHasMention?: boolean;
  friendsHasMention?: boolean;
  threadsHasMention?: boolean;
  /** Whether this segment controls an archived chat list. */
  archivedMode: boolean;
  /** Feature gate for the Friends tab. */
  friendsEnabled: boolean;
}

/** Numeric (or @) badge on a segment button; distinct from the row-level UnreadBadge icon badge. */
function SegmentBadge({ count, hasMention = false }: { count: number; hasMention?: boolean }) {
  if (hasMention) {
    return (
      <IonBadge mode="ios" color="primary" className={styles.badge}>
        @
      </IonBadge>
    );
  }
  if (count <= 0) return null;
  return (
    <IonBadge mode="ios" color="primary" className={styles.badge}>
      {formatUnreadBadge(count)}
    </IonBadge>
  );
}

/**
 * Second-level navigation over the chat list. The Friends tab requires the
 * friends feature gate. Pending friend requests surface as a badge on active
 * Friends lists (overriding the unread count - the request needs attention first).
 */
export function ChatListSegment({
  value,
  onChange,
  messagesUnreadCount,
  groupsUnreadCount,
  friendsUnreadCount,
  threadsUnreadCount,
  messagesHasMention,
  groupsHasMention,
  friendsHasMention,
  threadsHasMention,
  archivedMode,
  friendsEnabled,
}: ChatListSegmentProps) {
  const incomingRequestCount = useSelector(selectPendingIncomingCount);

  return (
    <div className={styles.segmentWrapper}>
      <IonSegment
        mode="ios"
        value={value}
        onIonChange={(e) => {
          const val = e.detail.value as ChatListTab | undefined;
          if (val) onChange(val);
        }}
      >
        <IonSegmentButton value="messages">
          <IonLabel>
            <Trans>Messages</Trans>
            <SegmentBadge count={messagesUnreadCount} hasMention={messagesHasMention} />
          </IonLabel>
        </IonSegmentButton>
        <IonSegmentButton value="groups">
          <IonLabel>
            <Trans>Groups</Trans>
            <SegmentBadge count={groupsUnreadCount} hasMention={groupsHasMention} />
          </IonLabel>
        </IonSegmentButton>
        {friendsEnabled && (
          <IonSegmentButton value="friends">
            <IonLabel>
              <Trans>Friends</Trans>
              {!archivedMode && incomingRequestCount > 0 ? (
                <IonBadge mode="ios" color="primary" className={styles.badge}>
                  {formatUnreadBadge(incomingRequestCount)}
                </IonBadge>
              ) : (
                <SegmentBadge count={friendsUnreadCount} hasMention={friendsHasMention} />
              )}
            </IonLabel>
          </IonSegmentButton>
        )}
        <IonSegmentButton value="threads">
          <IonLabel>
            <Trans>Threads</Trans>
            <SegmentBadge count={threadsUnreadCount} hasMention={threadsHasMention} />
          </IonLabel>
        </IonSegmentButton>
      </IonSegment>
    </div>
  );
}
