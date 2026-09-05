import { type ReactNode, useState } from 'react';
import axios, { HttpStatusCode } from 'axios';
import { IonButton, IonSpinner } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useDispatch } from 'react-redux';
import { type GroupInfoResponse } from '@/api/group';
import { redeemInvite } from '@/api/invites';
import { UserAvatar } from '@/components/UserAvatar';
import type { AppDispatch } from '@/store';
import { setChatMeta } from '@/store/chatsSlice';
import { refreshChatList } from '@/store/listPagination';
import { useInvitePreview } from './useInvitePreview';
import styles from './InvitePreviewCard.module.scss';

type InviteAction = {
  label: ReactNode;
  fill?: 'clear' | 'outline' | 'solid';
  disabled?: boolean;
  onClick: () => void | Promise<void>;
};

type InviteViewState =
  | { kind: 'loading' }
  | {
      kind: 'error';
      eyebrow: ReactNode;
      title: string;
      description: string;
      statusMessage: string;
      statusTone: 'error';
    }
  | {
      kind: 'loaded';
      eyebrow: ReactNode;
      title: string;
      description: string;
      statusMessage?: string;
      statusTone?: 'info' | 'error';
      supporting?: ReactNode;
      avatarUrl: string | null;
      actions: InviteAction[];
    };

type InviteErrorCopy = {
  title: string;
  message: string;
};

type InviteErrorContext = 'preview' | 'redeem';

export interface InvitePreviewCardProps {
  inviteCode: string;
  onResolved: (chat: GroupInfoResponse) => void | Promise<void>;
  onCancel: () => void;
  showAlreadyMemberOpenChatAction?: boolean;
}

function buildInviteError(context: InviteErrorContext, status?: number): InviteErrorCopy {
  switch (status) {
    case HttpStatusCode.Conflict:
      return {
        title: t`Invite unavailable`,
        message: t`You are already a member of this chat.`,
      };
    case HttpStatusCode.Forbidden:
      return {
        title: t`Invite unavailable`,
        message: t`This invite is not available for your account.`,
      };
    case HttpStatusCode.BadRequest:
      return {
        title: t`Invite unavailable`,
        message: t`This invite is invalid or has expired.`,
      };
    default:
      return {
        title: context === 'preview' ? t`Could not load invite` : t`Could not join chat`,
        message: context === 'preview' ? t`Please try again in a moment.` : t`We could not join this chat right now.`,
      };
  }
}

function useInviteChatResolver(onResolved: InvitePreviewCardProps['onResolved']) {
  const dispatch = useDispatch<AppDispatch>();

  return async (chat: GroupInfoResponse) => {
    const { id, ...meta } = chat;
    dispatch(setChatMeta({ chatId: id, meta }));

    try {
      await dispatch(refreshChatList(false));
    } catch {
      // The conversation can still load lazily after navigation.
    }

    await onResolved(chat);
  };
}

interface InviteHeroProps {
  eyebrow: ReactNode;
  title: string;
  description: string;
  showAvatar?: boolean;
  avatarUrl?: string | null;
}

function InviteHero({ eyebrow, title, description, showAvatar = false, avatarUrl }: InviteHeroProps) {
  return (
    <div className={styles.hero}>
      {showAvatar ? <UserAvatar name={title} avatarUrl={avatarUrl} size={96} className={styles.avatar} /> : null}
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
    </div>
  );
}

interface InviteStatusProps {
  message: string;
  tone?: 'info' | 'error';
}

function InviteStatus({ message, tone = 'info' }: InviteStatusProps) {
  const className = tone === 'error' ? `${styles.status} ${styles.statusError}` : styles.status;
  return <div className={className}>{message}</div>;
}

export function InvitePreviewCard({
  inviteCode,
  onResolved,
  onCancel,
  showAlreadyMemberOpenChatAction = true,
}: InvitePreviewCardProps) {
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<InviteErrorCopy | null>(null);
  const resolveChat = useInviteChatResolver(onResolved);
  const { previewState, preview, displayName } = useInvitePreview(inviteCode);

  const handleJoin = async () => {
    if (!preview || joining || preview.alreadyMember) return;

    setJoining(true);
    setJoinError(null);

    try {
      const response = await redeemInvite({ code: inviteCode });
      await resolveChat(response.data.chat);
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      setJoinError(buildInviteError('redeem', status));
    } finally {
      setJoining(false);
    }
  };

  const openChat = async () => {
    if (!preview) return;
    await resolveChat(preview.chat);
  };

  const viewState: InviteViewState = (() => {
    if (previewState.kind === 'loading') {
      return { kind: 'loading' };
    }

    if (previewState.kind === 'error') {
      const errorCopy = buildInviteError('preview', previewState.status);
      return {
        kind: 'error',
        eyebrow: <Trans>Invite</Trans>,
        title: errorCopy.title,
        description: errorCopy.message,
        statusMessage: errorCopy.message,
        statusTone: 'error',
      };
    }

    if (previewState.data.alreadyMember) {
      const actions: InviteAction[] = showAlreadyMemberOpenChatAction
        ? [
            {
              label: <Trans>Open chat</Trans>,
              onClick: openChat,
            },
            {
              label: <Trans>Back</Trans>,
              fill: 'clear',
              onClick: onCancel,
            },
          ]
        : [
            {
              label: <Trans>Not now</Trans>,
              fill: 'clear',
              onClick: onCancel,
            },
          ];

      return {
        kind: 'loaded',
        eyebrow: <Trans>Invite</Trans>,
        title: displayName,
        description:
          previewState.data.chat.description?.trim() || t`Join this chat to start reading and sending messages.`,
        statusMessage: t`You are already a member`,
        avatarUrl: previewState.data.chat.avatar,
        actions,
      };
    }

    return {
      kind: 'loaded',
      eyebrow: <Trans>You’ve been invited</Trans>,
      title: displayName,
      description:
        previewState.data.chat.description?.trim() || t`Join this chat to start reading and sending messages.`,
      statusMessage: joinError?.message,
      statusTone: joinError ? 'error' : undefined,
      supporting: <Trans>Review to confirm if you want to join. Nothing changes until you click join.</Trans>,
      avatarUrl: previewState.data.chat.avatar,
      actions: [
        {
          label: joining ? <Trans>Joining…</Trans> : <Trans>Join chat</Trans>,
          disabled: joining,
          onClick: handleJoin,
        },
        {
          label: <Trans>Not now</Trans>,
          fill: 'clear',
          onClick: onCancel,
        },
      ],
    };
  })();

  return (
    <div className={styles.card}>
      {viewState.kind === 'loading' ? (
        <div className={styles.loadingState}>
          <IonSpinner />
          <p className={styles.description}>
            <Trans>Loading invite…</Trans>
          </p>
        </div>
      ) : viewState.kind === 'error' ? (
        <>
          <InviteHero
            eyebrow={viewState.eyebrow}
            title={viewState.title}
            description={viewState.description}
            showAvatar={false}
            avatarUrl={null}
          />
          <InviteStatus message={viewState.statusMessage} tone={viewState.statusTone} />
        </>
      ) : (
        <>
          <InviteHero
            eyebrow={viewState.eyebrow}
            title={viewState.title}
            description={viewState.description}
            showAvatar
            avatarUrl={viewState.avatarUrl}
          />
          {viewState.statusMessage ? (
            <InviteStatus message={viewState.statusMessage} tone={viewState.statusTone} />
          ) : null}
          <div className={styles.actions}>
            {viewState.actions.map((action, index) => (
              <IonButton
                key={index}
                expand="block"
                size="large"
                fill={action.fill}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </IonButton>
            ))}
          </div>
          {viewState.supporting ? <p className={styles.supporting}>{viewState.supporting}</p> : null}
        </>
      )}
    </div>
  );
}
