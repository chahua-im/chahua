import {
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonText,
  IonSegment,
  IonSegmentButton,
  useIonActionSheet,
  useIonToast,
} from '@ionic/react';
import { checkmark, close, copyOutline, linkOutline, sendOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useDispatch } from 'react-redux';
import { useHistory } from 'react-router-dom';
import { createInvite, sendInviteMessage, type InviteInfoResponse } from '@/api/invites';
import { buildInviteUrl } from '@/utils/inviteUrl';
import type { GroupSelectorItem } from '@/api/group';
import type { MemberSummary } from '@/api/users';
import { messageAdded } from '@/store/messageEvents';
import type { AppDispatch } from '@/store';
import { useIsDesktop } from '@/hooks/platformHooks';
import { InsetContent } from '@/components/shared/InsetContent';
import { getChatDisplayName } from '@/utils/chatDisplay';
import { ShareInviteGroupSelectorModal } from './ShareInviteGroupSelectorModal';
import { ShareInviteMemberSelectorModal } from './ShareInviteMemberSelectorModal';
import {
  canCopyInviteCode,
  copyInviteCode,
  getExpiresAt,
  getExpiryLabel,
  getExpiryOptions,
  getInviteDescription,
  type InviteExpiryOption,
  type InviteMode,
} from './shareInviteHelpers';
import { createClientGeneratedId } from '@/utils/clientGeneratedId';
import { useShareInviteModalState } from './useShareInviteModalState';
import styles from './ShareInviteModal.module.scss';

interface ShareInviteModalProps {
  isOpen: boolean;
  chatId: string;
  onDismiss: () => void;
}

interface ConfigureStepProps {
  mode: InviteMode;
  selectedRequiredGroup: GroupSelectorItem | null;
  selectedTargetMember: MemberSummary | null;
  expiryOption: InviteExpiryOption;
  submitting: boolean;
  onModeChange: (mode: InviteMode) => void;
  onOpenRequiredGroupSelector: () => void;
  onOpenTargetMemberSelector: () => void;
  onOpenExpirySelector: () => void;
  onCreateInvite: () => void;
  onManageInviteLinks: () => void;
}

interface DestinationStepProps {
  isMembership: boolean;
  selectedDestinationGroup: GroupSelectorItem | null;
  submitting: boolean;
  draftInvite: InviteInfoResponse | null;
  onBack: () => void;
  onOpenSelector: () => void;
  onCopyCode: (invite: InviteInfoResponse) => void;
  onSendInvite: () => void;
}

function ConfigureStep({
  mode,
  selectedRequiredGroup,
  selectedTargetMember,
  expiryOption,
  submitting,
  onModeChange,
  onOpenRequiredGroupSelector,
  onOpenTargetMemberSelector,
  onOpenExpirySelector,
  onCreateInvite,
  onManageInviteLinks,
}: ConfigureStepProps) {
  const selectedTargetMemberLabel =
    selectedTargetMember?.username || (selectedTargetMember ? t`User ${selectedTargetMember.uid}` : null);

  return (
    <div className={styles.section}>
      <InsetContent>
        <div className={styles.hero}>
          <div className={styles.heroIconWrap}>
            <IonIcon icon={linkOutline} className={styles.heroIcon} />
          </div>
          <h2 className={styles.title}>
            <Trans>Invite Link</Trans>
          </h2>
        </div>

        <IonSegment value={mode} onIonChange={(event) => onModeChange(event.detail.value as InviteMode)}>
          <IonSegmentButton value="public">
            <IonLabel>
              <Trans>Public</Trans>
            </IonLabel>
          </IonSegmentButton>
          <IonSegmentButton value="membership">
            <IonLabel>
              <Trans>Membership</Trans>
            </IonLabel>
          </IonSegmentButton>
          <IonSegmentButton value="targeted">
            <IonLabel>
              <Trans>Targeted</Trans>
            </IonLabel>
          </IonSegmentButton>
        </IonSegment>

        <IonText color="medium" className={styles.descriptionText}>
          <p className={styles.description}>{getInviteDescription(mode)}</p>
        </IonText>
      </InsetContent>

      <IonList inset className={styles.formList}>
        {mode === 'membership' ? (
          <IonItem button detail={true} onClick={onOpenRequiredGroupSelector}>
            <IonLabel>
              <Trans>Member Group</Trans>
            </IonLabel>
            <IonNote slot="end" color="medium">
              {selectedRequiredGroup ? (
                getChatDisplayName(selectedRequiredGroup.id, selectedRequiredGroup.name)
              ) : (
                <Trans>Select</Trans>
              )}
            </IonNote>
          </IonItem>
        ) : null}

        {mode === 'targeted' ? (
          <IonItem button detail={true} onClick={onOpenTargetMemberSelector}>
            <IonLabel>
              <Trans>Target User</Trans>
            </IonLabel>
            <IonNote slot="end" color="medium">
              {selectedTargetMemberLabel || <Trans>Select</Trans>}
            </IonNote>
          </IonItem>
        ) : null}

        <IonItem button detail={true} onClick={onOpenExpirySelector}>
          <IonLabel>
            <Trans>Expires</Trans>
          </IonLabel>
          <IonNote slot="end" color="medium">
            {getExpiryLabel(expiryOption)}
          </IonNote>
        </IonItem>
      </IonList>

      <InsetContent>
        <div className={styles.actions}>
          <IonButton expand="block" onClick={onCreateInvite} disabled={submitting}>
            <Trans>Create Invite</Trans>
          </IonButton>
          <IonButton fill="clear" expand="block" onClick={onManageInviteLinks}>
            <Trans>Manage Invite Links</Trans>
          </IonButton>
        </div>
      </InsetContent>
    </div>
  );
}

function DestinationStep({
  isMembership,
  selectedDestinationGroup,
  submitting,
  draftInvite,
  onBack,
  onOpenSelector,
  onCopyCode,
  onSendInvite,
}: DestinationStepProps) {
  return (
    <div className={styles.section}>
      <InsetContent>
        <p className={styles.eyebrow}>
          <Trans>Invite Link Created</Trans>
        </p>
        <h2 className={styles.title}>
          <Trans>Share Invite</Trans>
        </h2>
        <p className={styles.description}>
          <Trans>Copy the link below, or choose a group to send it to right now.</Trans>
        </p>

        {draftInvite ? (
          <div className={styles.inviteCodeBox}>
            <span className={styles.inviteCode}>{buildInviteUrl(draftInvite.code)}</span>
            <IonButton
              fill="clear"
              size="small"
              className={styles.copyIconButton}
              disabled={!canCopyInviteCode()}
              onClick={() => onCopyCode(draftInvite)}
              aria-label={t`Copy code`}
            >
              <IonIcon slot="icon-only" icon={copyOutline} />
            </IonButton>
          </div>
        ) : null}
      </InsetContent>

      <IonList inset className={styles.list}>
        <IonItem button={!isMembership} detail={!isMembership} onClick={!isMembership ? onOpenSelector : undefined}>
          <IonLabel>
            <Trans>Destination Group</Trans>
          </IonLabel>
          <IonNote slot="end" color="medium">
            {selectedDestinationGroup ? (
              getChatDisplayName(selectedDestinationGroup.id, selectedDestinationGroup.name)
            ) : (
              <Trans>Select</Trans>
            )}
          </IonNote>
        </IonItem>
      </IonList>

      <InsetContent>
        <div className={styles.actionsInline}>
          <IonButton fill="clear" onClick={onBack}>
            <Trans>Back</Trans>
          </IonButton>
          <IonButton onClick={onSendInvite} disabled={submitting || !selectedDestinationGroup}>
            <IonIcon slot="start" icon={sendOutline} />
            <Trans>Send invite</Trans>
          </IonButton>
        </div>
      </InsetContent>
    </div>
  );
}

export function ShareInviteModal({ isOpen, chatId, onDismiss }: ShareInviteModalProps) {
  const isDesktop = useIsDesktop();

  return (
    <IonModal
      isOpen={isOpen}
      onDidDismiss={onDismiss}
      {...(!isDesktop ? { initialBreakpoint: 0.92, breakpoints: [0, 0.92] } : {})}
    >
      {isOpen ? <ShareInviteModalSession chatId={chatId} onDismiss={onDismiss} /> : null}
    </IonModal>
  );
}

function ShareInviteModalSession({ chatId, onDismiss }: Omit<ShareInviteModalProps, 'isOpen'>) {
  const dispatch = useDispatch<AppDispatch>();
  const history = useHistory();
  const isDesktop = useIsDesktop();
  const [presentToast] = useIonToast();
  const [presentActionSheet] = useIonActionSheet();
  const {
    step,
    mode,
    requiredChatId,
    selectedRequiredGroup,
    selectedTargetMember,
    selectedDestinationGroup,
    expiryOption,
    submitting,
    draftInvite,
    groupSelectorOpen,
    memberSelectorOpen,
    selectorTarget,
    setStep,
    changeMode,
    setSubmitting,
    changeExpiryOption,
    setDraftInvite,
    openSelector,
    closeSelector,
    selectRequiredGroup,
    selectDestinationGroup,
    openMemberSelector,
    closeMemberSelector,
    selectTargetMember,
  } = useShareInviteModalState();

  const copyCode = async (invite: InviteInfoResponse) => {
    if (!canCopyInviteCode()) {
      presentToast({ message: t`Clipboard is not available on this device`, duration: 2500 });
      return;
    }

    try {
      await copyInviteCode(invite);
      presentToast({ message: t`Invite link copied`, duration: 2000 });
    } catch {
      presentToast({ message: t`Failed to copy invite code`, duration: 2500 });
    }
  };

  const handleManageInviteLinks = () => {
    onDismiss();
    history.push(`/chats/chat/${chatId}/invites`);
  };

  const handleOpenExpirySelector = () => {
    presentActionSheet({
      header: t`Expires`,
      buttons: [
        ...getExpiryOptions().map((option) => ({
          text: option.label,
          icon: option.value === expiryOption ? checkmark : undefined,
          handler: () => changeExpiryOption(option.value),
        })),
        {
          text: t`Cancel`,
          role: 'cancel',
        },
      ],
    });
  };

  const handlePrimaryAction = async () => {
    if (mode === 'membership' && !requiredChatId) {
      presentToast({ message: t`Choose the member group first`, duration: 2500 });
      return;
    }

    if (mode === 'targeted' && !selectedTargetMember) {
      presentToast({ message: t`Choose the target user first`, duration: 2500 });
      return;
    }

    if (draftInvite) {
      setStep('destination');
      return;
    }

    setSubmitting(true);
    try {
      const response = await createInvite({
        chatId,
        inviteType: mode === 'membership' ? 'membership' : mode === 'targeted' ? 'targeted' : 'generic',
        targetUid: mode === 'targeted' ? selectedTargetMember?.uid : undefined,
        requiredChatId: mode === 'membership' ? requiredChatId : undefined,
        expiresAt: getExpiresAt(expiryOption),
      });
      setDraftInvite(response.data);
      if (mode === 'membership' && selectedRequiredGroup) {
        selectDestinationGroup(selectedRequiredGroup);
      }
      setStep('destination');
    } catch (error) {
      const message = error instanceof Error ? error.message : t`Failed to create invite`;
      presentToast({ message, duration: 3000 });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendInvite = async () => {
    if (!selectedDestinationGroup) {
      presentToast({ message: t`Choose a destination group`, duration: 2500 });
      return;
    }

    setSubmitting(true);
    try {
      const response = await sendInviteMessage({
        sourceChatId: chatId,
        destinationChatId: selectedDestinationGroup.id,
        inviteId: draftInvite?.id,
        expiresAt: getExpiresAt(expiryOption),
        clientGeneratedId: createClientGeneratedId('invite_'),
      });

      dispatch(
        messageAdded({
          chatId: response.data.message.chatId,
          storeChatId: response.data.message.chatId,
          message: response.data.message,
          origin: 'api_confirm',
          scope: 'main',
        }),
      );

      presentToast({
        message: t`Invite sent to ${getChatDisplayName(selectedDestinationGroup.id, selectedDestinationGroup.name)}`,
        duration: 2500,
      });
      onDismiss();
    } catch (error) {
      const message = error instanceof Error ? error.message : t`Failed to send invite`;
      presentToast({ message, duration: 3000 });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <IonContent color="light" className={styles.content}>
        <button type="button" className={styles.closeButton} onClick={onDismiss} aria-label={t`Close`}>
          <IonIcon icon={close} />
        </button>

        {step === 'configure' ? (
          <ConfigureStep
            mode={mode}
            selectedRequiredGroup={selectedRequiredGroup}
            selectedTargetMember={selectedTargetMember}
            expiryOption={expiryOption}
            submitting={submitting}
            onModeChange={changeMode}
            onOpenRequiredGroupSelector={() => openSelector('required')}
            onOpenTargetMemberSelector={openMemberSelector}
            onOpenExpirySelector={handleOpenExpirySelector}
            onCreateInvite={() => void handlePrimaryAction()}
            onManageInviteLinks={handleManageInviteLinks}
          />
        ) : null}

        {step === 'destination' ? (
          <DestinationStep
            isMembership={mode === 'membership'}
            selectedDestinationGroup={selectedDestinationGroup}
            submitting={submitting}
            draftInvite={draftInvite}
            onBack={() => setStep('configure')}
            onOpenSelector={() => openSelector('destination')}
            onCopyCode={(invite) => void copyCode(invite)}
            onSendInvite={() => void handleSendInvite()}
          />
        ) : null}
      </IonContent>

      <ShareInviteGroupSelectorModal
        isOpen={groupSelectorOpen}
        isDesktop={isDesktop}
        scope={selectorTarget === 'required' ? 'manageable' : 'joined'}
        onDismiss={closeSelector}
        onSelect={selectorTarget === 'required' ? selectRequiredGroup : selectDestinationGroup}
      />
      <ShareInviteMemberSelectorModal
        isOpen={memberSelectorOpen}
        isDesktop={isDesktop}
        chatId={chatId}
        onDismiss={closeMemberSelector}
        onSelect={selectTargetMember}
      />
    </>
  );
}
