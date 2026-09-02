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
  /** Whether this segment controls an archived chat list. */
  archivedMode: boolean;
  /** Feature gate for the Friends tab. */
  friendsEnabled: boolean;
}

function UnreadBadge({ count }: { count: number }) {
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
            <UnreadBadge count={messagesUnreadCount} />
          </IonLabel>
        </IonSegmentButton>
        <IonSegmentButton value="groups">
          <IonLabel>
            <Trans>Groups</Trans>
            <UnreadBadge count={groupsUnreadCount} />
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
                <UnreadBadge count={friendsUnreadCount} />
              )}
            </IonLabel>
          </IonSegmentButton>
        )}
        <IonSegmentButton value="threads">
          <IonLabel>
            <Trans>Threads</Trans>
            <UnreadBadge count={threadsUnreadCount} />
          </IonLabel>
        </IonSegmentButton>
      </IonSegment>
    </div>
  );
}
