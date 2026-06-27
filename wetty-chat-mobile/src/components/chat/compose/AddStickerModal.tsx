import { useEffect, useMemo, useState } from 'react';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonModal,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { close } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { EmojiInput } from '@/components/shared/EmojiInput';
import styles from './AddStickerModal.module.scss';
import { useIsDesktop } from '@/hooks/platformHooks';

interface AddStickerModalProps {
  file: File | null;
  onDismiss: () => void;
  onAdd: (file: File, emoji: string, name: string) => void;
}

export function AddStickerModal({ file, onDismiss, onAdd }: AddStickerModalProps) {
  const isDesktop = useIsDesktop();
  const fileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : 'empty';

  return (
    <IonModal
      isOpen={file != null}
      onDidDismiss={onDismiss}
      {...(!isDesktop ? { initialBreakpoint: 0.8, breakpoints: [0, 0.8] } : {})}
    >
      {file ? <AddStickerModalForm key={fileKey} file={file} onDismiss={onDismiss} onAdd={onAdd} /> : null}
    </IonModal>
  );
}

interface AddStickerModalFormProps {
  file: File;
  onDismiss: () => void;
  onAdd: (file: File, emoji: string, name: string) => void;
}

function AddStickerModalForm({ file, onDismiss, onAdd }: AddStickerModalFormProps) {
  const [emoji, setEmoji] = useState('');
  const [name, setName] = useState('');
  const [showEmojiError, setShowEmojiError] = useState(false);
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(
    () => () => {
      URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const handleAdd = () => {
    const trimmedEmoji = emoji.trim();
    if (!trimmedEmoji) {
      setShowEmojiError(true);
      return;
    }
    onAdd(file, trimmedEmoji, name.trim());
  };

  return (
    <>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonButton onClick={onDismiss} aria-label={t`Cancel`}>
              <IonIcon slot="icon-only" icon={close} />
            </IonButton>
          </IonButtons>
          <IonTitle>
            <Trans>Add Sticker</Trans>
          </IonTitle>
          <IonButtons slot="end">
            <IonButton strong onClick={handleAdd}>
              <Trans>Add</Trans>
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <div className={styles.previewContainer}>
          {file.type.startsWith('video/') ? (
            <video src={previewUrl} className={styles.previewMedia} autoPlay loop muted playsInline />
          ) : (
            <img src={previewUrl} alt={t`Sticker preview`} className={styles.previewMedia} />
          )}
        </div>
        <div className={styles.formFields}>
          <EmojiInput
            value={emoji}
            onChange={(value) => {
              setEmoji(value);
              if (value.trim()) {
                setShowEmojiError(false);
              }
            }}
            label={t`Emoji`}
            placeholder={t`e.g. 😊`}
            required
            invalid={showEmojiError}
            errorText={t`Please choose at least one emoji`}
            maxEmojiCount={4}
          />
          <IonInput
            className={styles.nameInput}
            value={name}
            label={t`Name`}
            labelPlacement="stacked"
            placeholder={t`Optional`}
            maxlength={255}
            counter
            onIonInput={(event) => setName(event.detail.value ?? '')}
          />
        </div>
      </IonContent>
    </>
  );
}
