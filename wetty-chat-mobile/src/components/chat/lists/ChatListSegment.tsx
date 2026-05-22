import { IonBadge, IonLabel, IonSegment, IonSegmentButton } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { formatUnreadCount } from '@/utils/unreadCount';
import styles from './ChatListSegment.module.scss';

export type ChatListTab = 'all' | 'groups' | 'threads';

interface ChatListSegmentProps {
  value: ChatListTab;
  onChange: (tab: ChatListTab) => void;
  allUnreadCount: number;
  groupsUnreadCount: number;
  threadsUnreadCount: number;
  showAllTab?: boolean;
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <IonBadge mode="ios" color="primary" className={styles.badge}>
      {formatUnreadCount(count)}
    </IonBadge>
  );
}

export function ChatListSegment({
  value,
  onChange,
  allUnreadCount,
  groupsUnreadCount,
  threadsUnreadCount,
  showAllTab = true,
}: ChatListSegmentProps) {
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
        <IonSegmentButton value="groups">
          <IonLabel>
            <Trans>Groups</Trans>
            <UnreadBadge count={groupsUnreadCount} />
          </IonLabel>
        </IonSegmentButton>
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
