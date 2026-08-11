import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
  useIonAlert,
  useIonToast,
} from '@ionic/react';
import { useHistory, useParams } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { requestGroupAvatarUploadUrl, updateGroupInfo } from '@/api/group';
import { uploadFileToS3 } from '@/api/upload';
import { categorizeAttachmentKind, detectFileMimeType, isHeicLikeMedia } from '@/utils/fileType';
import { setChatMeta } from '@/store/chatsSlice';
import { BackButton } from '@/components/BackButton';
import { GroupProfile } from '@/components/chat/profiles/GroupProfile';
import { ChatRoleGate } from '@/components/chat/permissions/ChatRoleGate';
import type { BackAction } from '@/types/back-action';
import { ChatAdminSettings } from '../ChatAdminSettings';
import styles from './GroupInfo.module.scss';
import { getInitialGroupInfoFormState, type GroupInfoFormState, useGroupInfoMetadata } from './useGroupInfoMetadata';

interface GroupSettingsCoreProps {
  chatId?: string;
  backAction?: BackAction;
}

function getMetadataSnapshot(state: Pick<GroupInfoFormState, 'name' | 'description' | 'visibility'>) {
  return {
    name: state.name.trim(),
    description: state.description.trim(),
    visibility: state.visibility,
  };
}

function GroupSettingsSession({ chatId, backAction }: { chatId: string; backAction?: BackAction }) {
  const history = useHistory();
  const dispatch = useDispatch();
  const [presentToast] = useIonToast();
  const [presentAlert] = useIonAlert();
  const { formState, loading, setFormState } = useGroupInfoMetadata(chatId);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [savedMetadataState, setSavedMetadataState] = useState(() => getMetadataSnapshot(formState));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const savedStateInitializedChatRef = useRef<string | null>(null);
  const unblockRef = useRef<null | (() => void)>(null);
  const shouldBypassPromptRef = useRef(false);
  const canEditAvatar = formState.myRole === 'admin';

  useEffect(() => {
    savedStateInitializedChatRef.current = null;
  }, [chatId]);

  useEffect(() => {
    if (loading || savedStateInitializedChatRef.current === chatId) {
      return;
    }

    setSavedMetadataState(getMetadataSnapshot(formState));
    savedStateInitializedChatRef.current = chatId;
  }, [chatId, formState, loading]);

  useEffect(() => {
    return () => {
      if (!formState.avatarUrl.startsWith('blob:')) return;
      URL.revokeObjectURL(formState.avatarUrl);
    };
  }, [formState.avatarUrl]);

  const metadataSnapshot = useMemo(() => getMetadataSnapshot(formState), [formState]);
  const hasUnsavedMetadataChanges =
    metadataSnapshot.name !== savedMetadataState.name ||
    metadataSnapshot.description !== savedMetadataState.description ||
    metadataSnapshot.visibility !== savedMetadataState.visibility;
  const saveDisabled = saving || uploadingAvatar || !hasUnsavedMetadataChanges;

  const runBackAction = useCallback(() => {
    if (!backAction) {
      history.replace(`/chats/chat/${chatId}/group-info`);
      return;
    }

    if (backAction.type === 'back') {
      if (history.length > 1) {
        history.goBack();
      } else {
        history.replace(backAction.defaultHref);
      }
      return;
    }

    if (backAction.type === 'callback') {
      backAction.onBack();
      return;
    }

    backAction.onClose();
  }, [backAction, chatId, history]);

  const confirmDiscardChanges = useCallback(
    (onDiscard: () => void) => {
      presentAlert({
        header: t`Discard changes?`,
        message: t`You have unsaved group detail changes. Leave without saving?`,
        buttons: [
          { text: t`Stay`, role: 'cancel' },
          {
            text: t`Discard`,
            role: 'destructive',
            handler: () => {
              shouldBypassPromptRef.current = true;
              onDiscard();
            },
          },
        ],
      });
    },
    [presentAlert],
  );

  useEffect(() => {
    if (!hasUnsavedMetadataChanges) {
      shouldBypassPromptRef.current = false;
      unblockRef.current?.();
      unblockRef.current = null;
      return;
    }

    const unblock = history.block((nextLocation, action) => {
      if (shouldBypassPromptRef.current) {
        return;
      }

      confirmDiscardChanges(() => {
        unblock();
        unblockRef.current = null;
        if (action === 'REPLACE') {
          history.replace(nextLocation);
          return;
        }
        if (action === 'PUSH') {
          history.push(nextLocation);
          return;
        }
        history.goBack();
      });

      return false;
    });

    unblockRef.current = unblock;

    return () => {
      unblock();
      if (unblockRef.current === unblock) {
        unblockRef.current = null;
      }
    };
  }, [confirmDiscardChanges, hasUnsavedMetadataChanges, history]);

  useEffect(() => {
    if (!hasUnsavedMetadataChanges) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedMetadataChanges]);

  const handleBack = () => {
    if (!hasUnsavedMetadataChanges) {
      runBackAction();
      return;
    }

    confirmDiscardChanges(() => {
      unblockRef.current?.();
      unblockRef.current = null;
      runBackAction();
    });
  };

  const handlePickAvatar = () => {
    if (!canEditAvatar || uploadingAvatar || saving) {
      return;
    }

    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    await handleAvatarUpload(file);
  };

  const handleAvatarUpload = async (file: File) => {
    const contentType = await detectFileMimeType(file);
    if (categorizeAttachmentKind(contentType) !== 'image') {
      presentToast({ message: t`Please choose an image file`, duration: 3000 });
      return;
    }
    if (isHeicLikeMedia({ mimeType: contentType, fileName: file.name })) {
      presentToast({ message: t`This image format isn't supported. Please choose a JPEG or PNG.`, duration: 3000 });
      return;
    }

    const previousAvatarUrl = formState.avatarUrl;
    const nextPreviewUrl = URL.createObjectURL(file);
    const previousPreviewUrl = previousAvatarUrl.startsWith('blob:') ? previousAvatarUrl : null;

    setUploadingAvatar(true);
    setFormState((current) => ({
      ...current,
      avatarUrl: nextPreviewUrl,
    }));

    try {
      const uploadRes = await requestGroupAvatarUploadUrl(chatId, {
        filename: file.name,
        contentType,
        size: file.size,
      });
      const { imageId, uploadUrl, uploadHeaders } = uploadRes.data;
      await uploadFileToS3(uploadUrl, file, uploadHeaders);
      const patchRes = await updateGroupInfo(chatId, {
        avatarImageId: imageId,
      });
      const { id, ...meta } = patchRes.data;
      void id;

      dispatch(setChatMeta({ chatId, meta }));

      setFormState((current) => ({
        ...current,
        avatarImageId: imageId,
        avatarUrl: meta.avatar || current.avatarUrl,
      }));

      if (previousPreviewUrl) {
        URL.revokeObjectURL(previousPreviewUrl);
      }
      presentToast({ message: t`Avatar uploaded`, duration: 2000 });
    } catch (err) {
      URL.revokeObjectURL(nextPreviewUrl);
      setFormState((current) => ({
        ...current,
        avatarUrl: previousAvatarUrl,
      }));
      presentToast({ message: err instanceof Error ? err.message : t`Failed to upload avatar`, duration: 3000 });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSave = () => {
    if (saveDisabled) {
      return;
    }
    setSaving(true);

    updateGroupInfo(chatId, {
      name: metadataSnapshot.name || undefined,
      description: metadataSnapshot.description || undefined,
      avatarImageId: formState.avatarImageId,
      visibility: metadataSnapshot.visibility,
    })
      .then((res) => {
        const { id, ...meta } = res.data;
        void id;
        dispatch(setChatMeta({ chatId, meta }));
        const nextFormState = getInitialGroupInfoFormState(meta);
        setFormState(nextFormState);
        setSavedMetadataState(getMetadataSnapshot(nextFormState));
        presentToast({ message: t`Group details saved`, duration: 2000 });
      })
      .catch((err: Error) => {
        presentToast({ message: err.message || t`Failed to save group info`, duration: 3000 });
      })
      .finally(() => setSaving(false));
  };

  const updateFormState = <K extends keyof GroupInfoFormState>(key: K, value: GroupInfoFormState[K]) => {
    setFormState((current) => ({ ...current, [key]: value }));
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <BackButton action={{ type: 'callback', onBack: handleBack }} />
          </IonButtons>
          <IonTitle>
            <Trans>Group Settings</Trans>
          </IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light" className="ion-no-padding">
        {loading ? (
          <div className={styles.loadingState}>
            <IonSpinner />
          </div>
        ) : (
          <>
            <GroupProfile
              chatId={chatId}
              name={formState.name}
              description={formState.description}
              avatarUrl={formState.avatarUrl}
              avatarEditable={canEditAvatar}
              avatarUploading={uploadingAvatar}
              onAvatarClick={handlePickAvatar}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className={styles.hiddenFileInput}
              onChange={handleFileChange}
            />

            <ChatRoleGate chatId={chatId} allow="admin" role={formState.myRole}>
              <ChatAdminSettings
                name={formState.name}
                description={formState.description}
                visibility={formState.visibility}
                saving={saving}
                saveDisabled={saveDisabled}
                onNameChange={(value) => updateFormState('name', value)}
                onDescriptionChange={(value) => updateFormState('description', value)}
                onVisibilityChange={(value) => updateFormState('visibility', value)}
                onSave={handleSave}
              />
            </ChatRoleGate>
          </>
        )}
      </IonContent>
    </IonPage>
  );
}

export default function GroupSettingsCore({ chatId: propChatId, backAction }: GroupSettingsCoreProps) {
  const { id } = useParams<{ id: string }>();
  const chatId = propChatId ?? (id ? String(id) : '');

  if (!chatId) {
    return null;
  }

  return <GroupSettingsSession key={chatId} chatId={chatId} backAction={backAction} />;
}

export function GroupSettingsPage() {
  const { id } = useParams<{ id: string }>();
  return <GroupSettingsCore chatId={id} backAction={{ type: 'back', defaultHref: `/chats/chat/${id}/group-info` }} />;
}
