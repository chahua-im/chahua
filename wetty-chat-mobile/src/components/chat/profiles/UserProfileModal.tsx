import { IonButton, IonChip, IonContent, IonIcon, IonLabel, IonModal, useIonAlert, useIonToast } from '@ionic/react';
import { close, openOutline, personAddOutline, chatbubbleEllipsesOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import type { User } from '@/api/messages';
import { useIsDarkMode, useIsDesktop } from '@/hooks/platformHooks';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { UserAvatar } from '@/components/UserAvatar';
import { useSelector } from 'react-redux';
import { useHistory } from 'react-router-dom';
import type { RootState } from '@/store';
import { friendsApi, type FriendRelationshipResponse } from '@/api/friends';
import { selectChatName } from '@/store/chatsSlice';
import { AddFriendSheet } from '@/components/social/AddFriendSheet';
import { getMembers, removeMember, updateMemberRole, type MemberResponse } from '@/api/group';
import { GroupSettingsActionButton } from '@/components/chat/settings/GroupSettingsActionButton';
import styles from './UserProfileModal.module.scss';

interface UserProfileModalProps {
  sender: User | null;
  onDismiss: () => void;
  chatId?: string | number;
  canManage?: boolean;
  member?: MemberResponse | null;
  onActionComplete?: () => void;
}

export function UserProfileModal({
  sender,
  onDismiss,
  chatId,
  canManage = false,
  member: memberProp = null,
  onActionComplete,
}: UserProfileModalProps) {
  const isDesktop = useIsDesktop();
  const isDarkMode = useIsDarkMode();
  const history = useHistory();
  const friendsEnabled = useFeatureGate('friends');
  const dmEnabled = useFeatureGate('directMessages');

  const contentRef = useRef<HTMLDivElement | null>(null);
  const [prevSender, setPrevSender] = useState<User | null>(sender);
  const [localSender, setLocalSender] = useState<User | null>(sender);
  const [memberInfo, setMemberInfo] = useState<MemberResponse | null>(memberProp);
  const [memberLoading, setMemberLoading] = useState(false);
  const [initialBreakpoint, setInitialBreakpoint] = useState<number | null>(null);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [relationship, setRelationship] = useState<FriendRelationshipResponse | null>(null);
  const [relationshipVersion, setRelationshipVersion] = useState(0);

  const isAnimatingRef = useRef(false);

  if (sender !== prevSender) {
    setPrevSender(sender);
    if (sender) {
      setLocalSender(sender);
      isAnimatingRef.current = true;
    } else {
      isAnimatingRef.current = false;
      setInitialBreakpoint(null);
    }
  }

  const displaySender = sender || localSender;
  const chatNameFromStore = useSelector((state: RootState) =>
    chatId != null ? selectChatName(state, String(chatId)) : null,
  );
  const groupName = displaySender?.userGroup?.name?.trim() || null;
  const currentUserId = useSelector((state: RootState) => state.user.uid);
  const isOwn = displaySender?.uid === currentUserId;
  const peerUid = displaySender?.uid ?? 0;
  const showAddFriend =
    friendsEnabled &&
    relationship != null &&
    !relationship.isFriend &&
    !relationship.blocking &&
    !relationship.blockedBy;
  const showMessage = friendsEnabled && dmEnabled && relationship?.canDm === true && relationship.dmChatId != null;

  // Profile actions depend on an authoritative, single-peer relationship
  // lookup—not on whether a paginated chat or friend list contains this user.
  useEffect(() => {
    if (!sender || !friendsEnabled || sender.uid === currentUserId) {
      setRelationship(null);
      return;
    }

    let cancelled = false;
    setRelationship(null);
    friendsApi
      .getRelationship(sender.uid)
      .then((nextRelationship) => {
        if (!cancelled) setRelationship(nextRelationship);
      })
      .catch(() => {
        if (!cancelled) setRelationship(null);
      });

    return () => {
      cancelled = true;
    };
  }, [sender, friendsEnabled, currentUserId, relationshipVersion]);

  const measure = useCallback(() => {
    const node = contentRef.current;
    if (!node) return null;

    const contentHeight = node.scrollHeight + 80;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const bpRaw = viewportHeight > 0 ? contentHeight / viewportHeight : null;
    const bp = bpRaw != null ? Math.max(0.3, Math.min(0.98, Number(bpRaw.toFixed(3)))) : null;

    if (bp != null) {
      if (isAnimatingRef.current) return bp;
      setInitialBreakpoint(bp);
    }
    return bp;
  }, []);

  useLayoutEffect(() => {
    if (isDesktop || !sender) {
      setInitialBreakpoint(null);
      return;
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && contentRef.current) {
      ro.observe(contentRef.current);
    }

    const onVh = measure;
    window.addEventListener('resize', onVh);
    window.visualViewport?.addEventListener('resize', onVh);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onVh);
      window.visualViewport?.removeEventListener('resize', onVh);
    };
  }, [isDesktop, sender, measure]);

  const handleDidPresent = useCallback(() => {
    isAnimatingRef.current = false;
    measure(); // trigger final measurement after opening completes
  }, [measure]);

  // Dynamically guess base height for smoother opening (avoids scrollbar flash)
  let fallbackBp = 0.52;
  if (canManage && !isOwn) {
    fallbackBp = 0.62;
  } else if (groupName) {
    fallbackBp = 0.55;
  }

  const mobileModalProps = !isDesktop
    ? initialBreakpoint != null
      ? { initialBreakpoint, breakpoints: [0, initialBreakpoint] as number[] }
      : { initialBreakpoint: fallbackBp, breakpoints: [0, fallbackBp] as number[] }
    : {};

  const [presentAlert] = useIonAlert();
  const [presentToast] = useIonToast();

  const displayName = displaySender?.name ?? (displaySender ? `User ${displaySender.uid}` : '');
  const groupNameColor = isDarkMode
    ? displaySender?.userGroup?.chatGroupColorDark || displaySender?.userGroup?.chatGroupColor || undefined
    : displaySender?.userGroup?.chatGroupColor || undefined;

  useEffect(() => {
    setMemberInfo(memberProp ?? null);
  }, [memberProp]);

  const loadMemberInfo = useCallback(() => {
    if (!chatId || !displaySender || !canManage) return;
    setMemberLoading(true);
    getMembers(chatId, { q: String(displaySender.uid), mode: 'submitted', limit: 1 })
      .then((res) => {
        const found = res.data.members.find((m) => m.uid === displaySender.uid) ?? null;
        setMemberInfo(found);
      })
      .catch(() => setMemberInfo(null))
      .finally(() => setMemberLoading(false));
  }, [chatId, canManage, displaySender]);

  useEffect(() => {
    if (sender && chatId && canManage && !memberProp) {
      loadMemberInfo();
    }
  }, [sender, chatId, canManage, memberProp, loadMemberInfo]);

  const doOnActionComplete = useCallback(() => {
    try {
      onActionComplete?.();
    } catch {
      // ignore
    }
  }, [onActionComplete]);

  const handleConfirmAction = useCallback(
    (
      header: string,
      message: string,
      successMessage: string,
      confirmText: string,
      actionFn: (value?: any) => Promise<any>,
      isDestructive = false,
      inputs?: any[],
    ) => {
      const alertOptions: Record<string, any> = {
        header,
        message,
        buttons: [
          { text: t`Cancel`, role: 'cancel' },
          {
            text: confirmText,
            role: isDestructive ? 'destructive' : undefined,
            handler: (value: string) => {
              actionFn(value)
                .then((msg: string | void) => {
                  presentToast(msg || successMessage, 2000);
                  doOnActionComplete();
                  onDismiss();
                })
                .catch((err: Error) => presentToast(err.message || t`Action failed`));
            },
          },
        ],
      };
      if (inputs) {
        alertOptions.inputs = inputs;
      }
      presentAlert(alertOptions);
    },
    [presentAlert, presentToast, doOnActionComplete, onDismiss],
  );

  const handlePromote = useCallback(() => {
    if (!chatId || !displaySender) return;
    const displayName = displaySender.name ?? `User ${displaySender.uid}`;
    handleConfirmAction(t`Promote Member`, t`Promote ${displayName} to admin?`, t`Member promoted`, t`Promote`, () =>
      updateMemberRole(chatId, displaySender.uid, { role: 'admin' }),
    );
  }, [chatId, displaySender, handleConfirmAction]);

  const handleDemote = useCallback(() => {
    if (!chatId || !displaySender) return;
    const displayName = displaySender.name ?? `User ${displaySender.uid}`;
    handleConfirmAction(t`Demote Member`, t`Demote ${displayName} to member?`, t`Member demoted`, t`Demote`, () =>
      updateMemberRole(chatId, displaySender.uid, { role: 'member' }),
    );
  }, [chatId, displaySender, handleConfirmAction]);

  const handleRemove = useCallback(() => {
    if (!chatId || !displaySender) return;
    const displayName = displaySender.name ?? `User ${displaySender.uid}`;
    const chatLabel = chatNameFromStore ?? t`this group`;
    handleConfirmAction(
      t`Remove Member`,
      t`Remove ${displayName} from ${chatLabel}?`,
      '', // message is dynamic here
      t`Remove`,
      async (value: string) => {
        const deleteMessages = value !== 'none' ? value : undefined;
        await removeMember(chatId, displaySender.uid, deleteMessages);
        return deleteMessages === 'all'
          ? t`Member removed, deleting all messages...`
          : deleteMessages === 'last24h'
            ? t`Member removed, deleting recent messages...`
            : t`Member removed`;
      },
      true,
      [
        { type: 'radio', label: t`Keep messages`, value: 'none', checked: true },
        { type: 'radio', label: t`Delete messages from last 24 hours`, value: 'last24h' },
        { type: 'radio', label: t`Delete all messages`, value: 'all' },
      ],
    );
  }, [chatId, displaySender, chatNameFromStore, handleConfirmAction]);

  const handleAddFriend = useCallback(() => {
    if (!displaySender) return;
    setAddFriendOpen(true);
  }, [displaySender]);

  const handleMessage = useCallback(() => {
    const dmChatId = relationship?.dmChatId;
    if (!dmChatId) return;
    onDismiss();
    history.push(`/chats/chat/${dmChatId}`);
  }, [relationship, onDismiss, history]);

  return (
    <>
      <IonModal isOpen={sender != null} onDidPresent={handleDidPresent} onDidDismiss={onDismiss} {...mobileModalProps}>
        <IonContent className="ion-padding" scrollY={false}>
          <button
            onClick={onDismiss}
            aria-label={t`Close`}
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              background: 'rgba(128, 128, 128, 0.2)',
              border: 'none',
              borderRadius: '50%',
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              zIndex: 10,
              transition: 'transform 0.2s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.1)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            <IonIcon icon={close} style={{ fontSize: 20, color: 'var(--ion-text-color)' }} />
          </button>
          {displaySender && (
            <div ref={contentRef} style={{ textAlign: 'center', paddingTop: 44 }}>
              <UserAvatar
                name={displayName}
                avatarUrl={displaySender.avatarUrl}
                size={80}
                style={{ display: 'inline-flex' }}
              />
              <h2>{displayName}</h2>
              {groupName && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    marginTop: 4,
                  }}
                >
                  <IonChip
                    outline
                    style={groupNameColor ? { color: groupNameColor, borderColor: groupNameColor } : undefined}
                  >
                    <IonLabel>{groupName}</IonLabel>
                  </IonChip>
                </div>
              )}
              <IonButton
                fill="outline"
                href={'https://www.shireyishunjian.com/main/home.php?mod=space&uid=' + displaySender.uid}
                target="_blank"
                size="small"
              >
                个人空间
                <IonIcon slot="end" icon={openOutline}></IonIcon>
              </IonButton>
              {isOwn && (
                <>
                  <IonButton
                    fill="outline"
                    href="https://www.shireyishunjian.com/main/forum.php?mod=viewthread&tid=209934"
                    target="_blank"
                    size="small"
                  >
                    修改用户名
                    <IonIcon slot="end" icon={openOutline}></IonIcon>
                  </IonButton>
                  <IonButton
                    fill="outline"
                    href="https://www.shireyishunjian.com/main/home.php?mod=spacecp&ac=avatar"
                    target="_blank"
                    size="small"
                  >
                    修改头像
                    <IonIcon slot="end" icon={openOutline}></IonIcon>
                  </IonButton>
                </>
              )}
              {canManage && !isOwn && (
                <div className={styles.buttonRow}>
                  {memberLoading ? (
                    <div style={{ color: 'var(--ion-text-color)' }}>{t`Loading...`}</div>
                  ) : memberInfo?.role === 'admin' ? (
                    <IonButton color="danger" fill="solid" onClick={handleDemote} className={styles.singleButton}>
                      {t`Demote to Member`}
                    </IonButton>
                  ) : memberInfo?.role === 'member' ? (
                    <>
                      <IonButton color="primary" fill="solid" onClick={handlePromote} className={styles.splitButton}>
                        {t`Promote to Admin`}
                      </IonButton>
                      <IonButton color="danger" fill="solid" onClick={handleRemove} className={styles.splitButton}>
                        {t`Remove from Group`}
                      </IonButton>
                    </>
                  ) : null}
                </div>
              )}
              {(showAddFriend || showMessage) && !isOwn && displaySender && (
                <div className={styles.socialActions}>
                  {showAddFriend && (
                    <GroupSettingsActionButton
                      icon={personAddOutline}
                      onClick={handleAddFriend}
                      disabled={relationship?.hasPendingOutgoingRequest === true}
                    >
                      {t`Add Friend`}
                    </GroupSettingsActionButton>
                  )}
                  {showMessage && (
                    <GroupSettingsActionButton icon={chatbubbleEllipsesOutline} onClick={() => void handleMessage()}>
                      {t`Message`}
                    </GroupSettingsActionButton>
                  )}
                </div>
              )}
            </div>
          )}
        </IonContent>
      </IonModal>
      <AddFriendSheet
        targetUid={peerUid}
        targetName={displayName}
        isOpen={addFriendOpen}
        onDismiss={() => setAddFriendOpen(false)}
        onSent={() => setRelationshipVersion((version) => version + 1)}
      />
    </>
  );
}
