import { type ReactNode } from 'react';
import { IonCard, IonCardHeader, IonCardSubtitle, IonIcon, IonItem, IonLabel, IonSkeletonText } from '@ionic/react';
import { chevronForward, mailOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { User } from '@/api/messages';
import { UserAvatar } from '@/components/UserAvatar';
import { useInvitePreview } from '@/components/invites/useInvitePreview';
import styles from './InviteMessageCard.module.scss';

interface InviteMessageCardProps {
  inviteCode: string;
  sender: User;
  isSent: boolean;
  showName: boolean;
  showAvatar: boolean;
  timestamp: string;
  onAvatarClick?: () => void;
  onOpen: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

type CardBodyViewState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      avatar?: ReactNode;
      title: ReactNode;
      description: ReactNode;
      clickable: boolean;
    };

function InviteCardBody({ viewState }: { viewState: CardBodyViewState }) {
  return (
    <IonItem lines="none" className={styles.groupItem}>
      <div slot="start" className={styles.leadingVisual}>
        {viewState.kind === 'loading' ? (
          <IonSkeletonText animated className={styles.skeletonAvatar} />
        ) : (
          (viewState.avatar ?? null)
        )}
      </div>
      <IonLabel>
        {viewState.kind === 'loading' ? (
          <>
            <IonSkeletonText animated className={styles.skeletonName} />
            <IonSkeletonText animated className={styles.skeletonDescription} />
          </>
        ) : (
          <>
            <h2 className={styles.groupName}>{viewState.title}</h2>
            <p className={styles.groupDescription}>{viewState.description}</p>
          </>
        )}
      </IonLabel>
      {viewState.kind === 'ready' && viewState.clickable ? (
        <IonIcon icon={chevronForward} slot="end" className={styles.chevron} />
      ) : null}
    </IonItem>
  );
}

export function InviteMessageCard({
  inviteCode,
  sender,
  isSent,
  showName,
  showAvatar,
  timestamp,
  onAvatarClick,
  onOpen,
}: InviteMessageCardProps) {
  const { previewState, preview, displayName } = useInvitePreview(inviteCode);
  const senderName = sender.name ?? `User ${sender.uid}`;
  let bodyViewState: CardBodyViewState;
  const inviteAvailable = previewState.kind === 'loaded' && !!preview;

  if (previewState.kind === 'loading') {
    bodyViewState = { kind: 'loading' };
  } else if (previewState.kind === 'loaded' && preview) {
    bodyViewState = {
      kind: 'ready',
      avatar: (
        <UserAvatar name={displayName} avatarUrl={preview.chat.avatar} size={44} className={styles.groupAvatar} />
      ),
      title: displayName,
      description: preview.chat.description?.trim() || t`Open this invite to view the group and join.`,
      clickable: true,
    };
  } else {
    bodyViewState = {
      kind: 'ready',
      title: <Trans>Invite unavailable</Trans>,
      description: <Trans>This invite may have expired or been revoked.</Trans>,
      clickable: false,
    };
  }

  return (
    <div className={`${styles.row} ${isSent ? styles.rowSent : ''}`}>
      {showAvatar ? (
        <button type="button" className={styles.avatarButton} onClick={onAvatarClick}>
          <UserAvatar name={senderName} avatarUrl={sender.avatarUrl} size={36} />
        </button>
      ) : (
        <div className={styles.avatarSpacer} />
      )}

      <div className={styles.content}>
        {showName && !isSent && <div className={styles.senderName}>{senderName}</div>}

        <div className={`${styles.cardRow} ${isSent ? styles.sentRow : ''}`}>
          <button
            type="button"
            className={`${styles.card} ${!inviteAvailable ? styles.cardDisabled : ''}`}
            onClick={inviteAvailable ? onOpen : undefined}
            disabled={!inviteAvailable}
          >
            <IonCard className={styles.ionCard}>
              <IonCardHeader className={styles.cardHeader}>
                <IonCardSubtitle className={styles.cardSubtitle}>
                  <IonIcon icon={mailOutline} />
                  <Trans>Group invite</Trans>
                </IonCardSubtitle>
              </IonCardHeader>
              <InviteCardBody viewState={bodyViewState} />
            </IonCard>
          </button>

          <div className={styles.timestamp}>{formatTime(timestamp)}</div>
        </div>
      </div>
    </div>
  );
}
