import { IonBadge, IonLabel, IonSegment, IonSegmentButton } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { useSelector } from 'react-redux';
import { formatUnreadBadge } from '@/utils/unreadBadge';
import {
  selectShowAllTab,
  selectShowFriendsTab,
  selectShowGroupsTab,
  selectShowThreadsTab,
} from '@/store/settingsSlice';
import { selectIncomingRequests } from '@/store/socialSlice';
import styles from './ChatListSegment.module.scss';

export type ChatListTab = 'all' | 'groups' | 'friends' | 'threads';

interface ChatListSegmentProps {
  value: ChatListTab;
  onChange: (tab: ChatListTab) => void;
  allUnreadCount: number;
  groupsUnreadCount: number;
  friendsUnreadCount: number;
  threadsUnreadCount: number;
  /** Feature gate for the Friends tab; also needs the settings toggle on. */
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
 * Second-level navigation over the chat list. Which tabs exist is controlled
 * from Settings > General; the Friends tab additionally requires the friends
 * feature gate. Pending friend requests surface as a badge on the Friends
 * tab (overriding the unread count - the request needs attention first).
 */
export function ChatListSegment({
  value,
  onChange,
  allUnreadCount,
  groupsUnreadCount,
  friendsUnreadCount,
  threadsUnreadCount,
  friendsEnabled,
}: ChatListSegmentProps) {
  const showAllTab = useSelector(selectShowAllTab);
  const showGroupsTab = useSelector(selectShowGroupsTab);
  const showFriendsTab = useSelector(selectShowFriendsTab) && friendsEnabled;
  const showThreadsTab = useSelector(selectShowThreadsTab);
  const incomingRequestCount = useSelector(selectIncomingRequests).length;

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
        {showAllTab && (
          <IonSegmentButton value="all">
            <IonLabel>
              <Trans>All</Trans>
              <UnreadBadge count={allUnreadCount} />
            </IonLabel>
          </IonSegmentButton>
        )}
        {showGroupsTab && (
          <IonSegmentButton value="groups">
            <IonLabel>
              <Trans>Groups</Trans>
              <UnreadBadge count={groupsUnreadCount} />
            </IonLabel>
          </IonSegmentButton>
        )}
        {showFriendsTab && (
          <IonSegmentButton value="friends">
            <IonLabel>
              <Trans>Friends</Trans>
              {incomingRequestCount > 0 ? (
                <IonBadge mode="ios" color="primary" className={styles.badge}>
                  {formatUnreadBadge(incomingRequestCount)}
                </IonBadge>
              ) : (
                <UnreadBadge count={friendsUnreadCount} />
              )}
            </IonLabel>
          </IonSegmentButton>
        )}
        {showThreadsTab && (
          <IonSegmentButton value="threads">
            <IonLabel>
              <Trans>Threads</Trans>
              <UnreadBadge count={threadsUnreadCount} />
            </IonLabel>
          </IonSegmentButton>
        )}
      </IonSegment>
    </div>
  );
}
