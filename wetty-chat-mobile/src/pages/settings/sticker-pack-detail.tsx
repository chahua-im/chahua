import { useCallback, useEffect, useState } from 'react';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonAlert,
  useIonToast,
} from '@ionic/react';
import { trashOutline, createOutline } from 'ionicons/icons';
import { useParams, useHistory } from 'react-router-dom';
import { t } from '@lingui/core/macro';
import { StickerImage } from '@/components/shared/StickerImage';
import { Trans } from '@lingui/react/macro';
import { useDispatch, useSelector } from 'react-redux';
import { BackButton } from '@/components/BackButton';
import { AddStickerModal } from '@/components/chat/compose/AddStickerModal';
import { useAddSticker } from '@/hooks/useAddSticker';
import {
  deleteStickerPack,
  getStickerPack,
  removeStickerFromPack,
  updateStickerPack,
  type StickerPackDetailResponse,
  type StickerSummary,
  unsubscribeStickerPack,
} from '@/api/stickers';
import type { RootState } from '@/store';
import type { AppDispatch } from '@/store/index';
import { removeStickerPackOrderItem } from '@/store/stickerPreferencesSlice';
import type { BackAction } from '@/types/back-action';
import styles from './StickerPackDetail.module.scss';

interface StickerPackDetailCoreProps {
  packId: string;
  backAction?: BackAction;
}

export function StickerPackDetailCore({ packId, backAction }: StickerPackDetailCoreProps) {
  const dispatch = useDispatch<AppDispatch>();
  const history = useHistory();
  const currentUserId = useSelector((state: RootState) => state.user.uid);
  const [pack, setPack] = useState<StickerPackDetailResponse | null>(null);
  const [presentAlert] = useIonAlert();
  const [presentToast] = useIonToast();

  const { addStickerFile, setAddStickerFile, fileInputRef, handleFileChange, handleAddSticker } = useAddSticker({
    packId,
    onSuccess: (newSticker) => {
      setPack((prev) =>
        prev
          ? {
              ...prev,
              stickerCount: prev.stickerCount + 1,
              stickers: [...prev.stickers, newSticker],
            }
          : prev,
      );
    },
  });

  const loadPack = useCallback(async () => {
    try {
      const res = await getStickerPack(packId);
      setPack(res.data);
    } catch (error) {
      console.error('Failed to load sticker pack', error);
      presentToast({ message: t`Failed to load sticker pack`, duration: 2000, position: 'bottom' });
    }
  }, [packId, presentToast]);

  useEffect(() => {
    const run = async () => {
      await loadPack();
    };

    void run();
  }, [loadPack]);

  if (!pack) {
    return (
      <IonPage>
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              {backAction ? (
                <BackButton action={backAction} />
              ) : (
                <IonBackButton text={t`Back`} defaultHref="/settings/stickers" />
              )}
            </IonButtons>
            <IonTitle>
              <Trans>Pack</Trans>
            </IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding">
          <p>
            <Trans>Loading...</Trans>
          </p>
        </IonContent>
      </IonPage>
    );
  }

  const owned = pack.ownerUid === currentUserId;

  const handleRemoveSticker = (sticker: StickerSummary) => {
    presentAlert({
      header: t`Remove Sticker`,
      message: t`Remove this sticker from the pack?`,
      buttons: [
        { text: t`Cancel`, role: 'cancel' },
        {
          text: t`Remove`,
          role: 'destructive',
          handler: async () => {
            try {
              await removeStickerFromPack(packId, sticker.id);
              setPack((prev) =>
                prev
                  ? {
                      ...prev,
                      stickerCount: Math.max(prev.stickerCount - 1, 0),
                      stickers: prev.stickers.filter((item) => item.id !== sticker.id),
                    }
                  : prev,
              );
            } catch (error) {
              console.error('Failed to remove sticker', error);
              presentToast({ message: t`Failed to remove sticker`, duration: 2000, position: 'bottom' });
            }
          },
        },
      ],
    });
  };

  const handleUnsubscribe = () => {
    presentAlert({
      header: t`Unsubscribe`,
      message: t`Remove this pack from your collection?`,
      buttons: [
        { text: t`Cancel`, role: 'cancel' },
        {
          text: t`Unsubscribe`,
          role: 'destructive',
          handler: async () => {
            try {
              await unsubscribeStickerPack(packId);
              dispatch(removeStickerPackOrderItem(packId));
              history.replace('/settings/stickers');
            } catch (error) {
              console.error('Failed to unsubscribe from sticker pack', error);
              presentToast({ message: t`Failed to unsubscribe`, duration: 2000, position: 'bottom' });
            }
          },
        },
      ],
    });
  };

  const handleDeletePack = () => {
    presentAlert({
      header: t`Delete Pack`,
      message: t`Delete this sticker pack? Stickers will stay available elsewhere, but this pack and its contents list will be removed.`,
      buttons: [
        { text: t`Cancel`, role: 'cancel' },
        {
          text: t({ message: 'Delete', context: 'sticker pack' }),
          role: 'destructive',
          handler: async () => {
            try {
              await deleteStickerPack(packId);
              dispatch(removeStickerPackOrderItem(packId));
              history.replace('/settings/stickers');
            } catch (error) {
              console.error('Failed to delete sticker pack', error);
              presentToast({ message: t`Failed to delete sticker pack`, duration: 2000, position: 'bottom' });
            }
          },
        },
      ],
    });
  };

  const handleRenamePack = () => {
    presentAlert({
      header: t`Rename Pack`,
      inputs: [
        {
          name: 'name',
          type: 'text',
          placeholder: t`Pack name`,
          value: pack?.name,
        },
      ],
      buttons: [
        { text: t`Cancel`, role: 'cancel' },
        {
          text: t`Save`,
          handler: async (data: { name: string }) => {
            const newName = data.name.trim();
            if (!newName || newName === pack?.name) return false;
            try {
              const res = await updateStickerPack(packId, { name: newName });
              setPack((prev) => (prev ? { ...prev, name: res.data.name } : prev));
              presentToast({ message: t`Pack renamed`, duration: 2000, position: 'bottom' });
            } catch (error) {
              console.error('Failed to rename sticker pack', error);
              presentToast({ message: t`Failed to rename pack`, duration: 2000, position: 'bottom' });
            }
          },
        },
      ],
    });
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {backAction ? (
              <BackButton action={backAction} />
            ) : (
              <IonBackButton text={t`Back`} defaultHref="/settings/stickers" />
            )}
          </IonButtons>
          <IonTitle>{pack.name}</IonTitle>
          {owned && (
            <IonButtons slot="end">
              <IonButton onClick={handleRenamePack} aria-label={t`Rename pack`}>
                <IonIcon slot="icon-only" icon={createOutline} />
              </IonButton>
              <IonButton color="danger" onClick={handleDeletePack} aria-label={t`Delete pack`}>
                <IonIcon slot="icon-only" icon={trashOutline} />
              </IonButton>
            </IonButtons>
          )}
          {!owned && (
            <IonButtons slot="end">
              <IonButton color="danger" onClick={handleUnsubscribe}>
                <Trans>Unsubscribe</Trans>
              </IonButton>
            </IonButtons>
          )}
        </IonToolbar>
      </IonHeader>
      <IonContent color="light">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/webm"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        {owned && (
          <div className={styles.hint}>
            <Trans>Tap a sticker to remove it from this pack.</Trans>
          </div>
        )}
        <div className={styles.grid}>
          {owned && (
            <button
              type="button"
              className={`${styles.cell} ${styles.addCell}`}
              aria-label={t`Add sticker`}
              onClick={() => fileInputRef.current?.click()}
            >
              <span className={styles.addIcon} aria-hidden="true">
                +
              </span>
            </button>
          )}
          {pack.stickers.map((sticker) => (
            <button
              key={sticker.id}
              type="button"
              className={styles.cell}
              aria-label={sticker.name || sticker.emoji}
              onClick={owned ? () => handleRemoveSticker(sticker) : undefined}
              style={{ cursor: owned ? 'pointer' : 'default' }}
            >
              <StickerImage src={sticker.media.url} alt="" className={styles.preview} />
              {owned && (
                <span className={styles.removeHint} aria-hidden="true">
                  ✕
                </span>
              )}
            </button>
          ))}
        </div>
      </IonContent>
      <AddStickerModal file={addStickerFile} onDismiss={() => setAddStickerFile(null)} onAdd={handleAddSticker} />
    </IonPage>
  );
}

export default function StickerPackDetailPage() {
  const { packId, id: chatId } = useParams<{ packId: string; id?: string }>();
  const defaultHref = chatId ? `/chats/chat/${chatId}` : '/settings/stickers';
  return <StickerPackDetailCore packId={packId} backAction={{ type: 'back', defaultHref }} />;
}
