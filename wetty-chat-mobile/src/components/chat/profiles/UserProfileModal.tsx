import { IonButton, IonChip, IonContent, IonIcon, IonLabel, IonModal, useIonAlert, useIonToast } from '@ionic/react';
import { close, openOutline, personAddOutline, chatbubbleEllipsesOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import type { User } from '@/api/messages';
import { useIsDarkMode, useIsDesktop } from '@/hooks/platformHooks';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { UserAvatar } from '@/components/UserAvatar';
import { useDispatch, useSelector } from 'react-redux';
import { useHistory } from 'react-router-dom';
import type { AppDispatch, RootState } from '@/store';
import { getChats } from '@/api/chats';
import { selectChatName, setChatsList } from '@/store/chatsSlice';
import {
  fetchBlocks,
  fetchFriends,
  fetchIncomingRequests,
  fetchOutgoingRequests,
  selectBlocksLoaded,
  selectFriendsLoaded,
  selectIncomingRequestFrom,
  selectIsBlocked,
  selectIsFriend,
  selectOutgoingRequestTo,
  selectRequestsLoaded,
} from '@/store/socialSlice';
import { friendsApi } from '@/api/friends';
import { blocksApi } from '@/api/blocks';
import { dmsApi } from '@/api/dms';
import { getMembers, removeMember, updateMemberRole, type MemberResponse } from '@/api/group';
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
  const dispatch = useDispatch<AppDispatch>();
  const history = useHistory();
  const friendsEnabled = useFeatureGate('friends');
  const dmEnabled = useFeatureGate('directMessages');
  const blockEnabled = useFeatureGate('userBlock');
  const socialEnabled = friendsEnabled || dmEnabled || blockEnabled;

  const contentRef = useRef<HTMLDivElement | null>(null);
  const [prevSender, setPrevSender] = useState<User | null>(sender);
  const [localSender, setLocalSender] = useState<User | null>(sender);
  const [memberInfo, setMemberInfo] = useState<MemberResponse | null>(memberProp);
  const [memberLoading, setMemberLoading] = useState(false);
  const [initialBreakpoint, setInitialBreakpoint] = useState<number | null>(null);

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
  const isFriend = useSelector((state: RootState) =>
    friendsEnabled && peerUid ? selectIsFriend(state, peerUid) : false,
  );
  const isBlocked = useSelector((state: RootState) =>
    blockEnabled && peerUid ? selectIsBlocked(state, peerUid) : false,
  );
  const incomingReq = useSelector((state: RootState) =>
    friendsEnabled && peerUid ? selectIncomingRequestFrom(state, peerUid) : undefined,
  );
  const outgoingReq = useSelector((state: RootState) =>
    friendsEnabled && peerUid ? selectOutgoingRequestTo(state, peerUid) : undefined,
  );
  const friendsLoaded = useSelector(selectFriendsLoaded);
  const requestsLoaded = useSelector(selectRequestsLoaded);
  const blocksLoaded = useSelector(selectBlocksLoaded);

  // Lazily hydrate social state the first time the sheet is opened so the
  // friend/block/request affordances reflect server truth even when the user
  // opens a profile without having visited the Contacts tab.
  useEffect(() => {
    if (!sender) return;
    if (friendsEnabled) {
      if (!friendsLoaded) dispatch(fetchFriends());
      if (!requestsLoaded) {
        dispatch(fetchIncomingRequests());
        dispatch(fetchOutgoingRequests());
      }
    }
    if (blockEnabled && !blocksLoaded) dispatch(fetchBlocks());
  }, [sender, friendsEnabled, blockEnabled, friendsLoaded, requestsLoaded, blocksLoaded, dispatch]);

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

  const refreshSocial = useCallback(() => {
    dispatch(fetchFriends());
    dispatch(fetchIncomingRequests());
    dispatch(fetchOutgoingRequests());
  }, [dispatch]);

  const handleAddFriend = useCallback(async () => {
    if (!displaySender) return;
    try {
      await friendsApi.createRequest(displaySender.uid);
      presentToast(t`Friend request sent`, 2000);
      dispatch(fetchOutgoingRequests());
    } catch (err) {
      presentToast(err instanceof Error ? err.message : t`Failed to send request`, 2000);
    }
  }, [displaySender, presentToast, dispatch]);

  const handleCancelRequest = useCallback(async () => {
    if (!outgoingReq) return;
    try {
      await friendsApi.cancelRequest(outgoingReq.id);
      dispatch(fetchOutgoingRequests());
    } catch (err) {
      presentToast(err instanceof Error ? err.message : t`Failed to cancel request`, 2000);
    }
  }, [outgoingReq, dispatch, presentToast]);

  const handleAcceptRequest = useCallback(async () => {
    if (!incomingReq) return;
    try {
      await friendsApi.acceptRequest(incomingReq.id);
      refreshSocial();
    } catch (err) {
      presentToast(err instanceof Error ? err.message : t`Failed to accept request`, 2000);
    }
  }, [incomingReq, refreshSocial, presentToast]);

  const handleRejectRequest = useCallback(async () => {
    if (!incomingReq) return;
    try {
      await friendsApi.rejectRequest(incomingReq.id);
      dispatch(fetchIncomingRequests());
    } catch (err) {
      presentToast(err instanceof Error ? err.message : t`Failed to reject request`, 2000);
    }
  }, [incomingReq, dispatch, presentToast]);

  const handleUnfriend = useCallback(() => {
    if (!displaySender) return;
    const name = displaySender.name ?? `User ${displaySender.uid}`;
    handleConfirmAction(
      t`Remove Friend`,
      t`Remove ${name} from your friends?`,
      t`Removed friend`,
      t`Remove`,
      () => friendsApi.removeFriend(displaySender.uid),
      true,
    );
  }, [displaySender, handleConfirmAction]);

  const handleBlock = useCallback(() => {
    if (!displaySender) return;
    const name = displaySender.name ?? `User ${displaySender.uid}`;
    handleConfirmAction(
      t`Block User`,
      t`Block ${name}? They won't be able to message you, and you will no longer be friends.`,
      t`User blocked`,
      t`Block`,
      async () => {
        await blocksApi.blockUser(displaySender.uid);
        dispatch(fetchBlocks());
        dispatch(fetchFriends());
      },
      true,
    );
  }, [displaySender, handleConfirmAction, dispatch]);

  const handleUnblock = useCallback(() => {
    if (!displaySender) return;
    handleConfirmAction(
      t`Unblock User`,
      t`Unblock this user?`,
      t`User unblocked`,
      t`Unblock`,
      async () => {
        await blocksApi.unblockUser(displaySender.uid);
        dispatch(fetchBlocks());
      },
    );
  }, [displaySender, handleConfirmAction, dispatch]);

  const handleMessage = useCallback(async () => {
    if (!displaySender) return;
    try {
      const res = await dmsApi.createDm(displaySender.uid);
      try {
        const chatsRes = await getChats();
        dispatch(setChatsList({ chats: chatsRes.data.chats || [] }));
      } catch {
        // Non-fatal: the conversation view will load its own metadata.
      }
      onDismiss();
      history.push(`/chats/chat/${res.id}`);
    } catch (err) {
      presentToast(err instanceof Error ? err.message : t`Failed to open conversation`, 2000);
    }
  }, [displaySender, dispatch, onDismiss, history, presentToast]);

  return (
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
            {socialEnabled && !isOwn && displaySender && (
              <div className={styles.buttonRow}>
                {friendsEnabled && dmEnabled && isFriend && (
                  <IonButton
                    fill="solid"
                    color="primary"
                    onClick={handleMessage}
                    className={styles.splitButton}
                  >
                    <IonIcon slot="start" icon={chatbubbleEllipsesOutline} />
                    {t`Message`}
                  </IonButton>
                )}
                {friendsEnabled && isFriend && (
                  <IonButton
                    fill="outline"
                    color="danger"
                    onClick={handleUnfriend}
                    className={styles.splitButton}
                  >
                    {t`Unfriend`}
                  </IonButton>
                )}
                {friendsEnabled && !isFriend && outgoingReq && (
                  <IonButton
                    fill="outline"
                    color="medium"
                    onClick={handleCancelRequest}
                    className={styles.singleButton}
                  >
                    {t`Cancel Request`}
                  </IonButton>
                )}
                {friendsEnabled && !isFriend && incomingReq && (
                  <>
                    <IonButton
                      fill="solid"
                      color="primary"
                      onClick={handleAcceptRequest}
                      className={styles.splitButton}
                    >
                      {t`Accept`}
                    </IonButton>
                    <IonButton
                      fill="outline"
                      color="danger"
                      onClick={handleRejectRequest}
                      className={styles.splitButton}
                    >
                      {t`Reject`}
                    </IonButton>
                  </>
                )}
                {friendsEnabled && !isFriend && !outgoingReq && !incomingReq && (
                  <IonButton
                    fill="solid"
                    color="primary"
                    onClick={handleAddFriend}
                    className={styles.singleButton}
                  >
                    <IonIcon slot="start" icon={personAddOutline} />
                    {t`Add Friend`}
                  </IonButton>
                )}
                {blockEnabled &&
                  (isBlocked ? (
                    <IonButton
                      fill="outline"
                      color="medium"
                      onClick={handleUnblock}
                      className={styles.singleButton}
                    >
                      {t`Unblock`}
                    </IonButton>
                  ) : (
                    <IonButton
                      fill="outline"
                      color="danger"
                      onClick={handleBlock}
                      className={styles.singleButton}
                    >
                      {t`Block`}
                    </IonButton>
                  ))}
              </div>
            )}
          </div>
        )}
      </IonContent>
    </IonModal>
  );
}
