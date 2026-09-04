import { useState, useCallback } from 'react';
import { IonButton, IonIcon, IonInput, IonPopover } from '@ionic/react';
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react';
import { happyOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { extractEmojiSequences, isEmojiSequence } from '@/utils/emojiSequences';
import { useIsDarkMode } from '@/hooks/platformHooks';
import styles from './EmojiInput.module.scss';

interface EmojiInputProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  invalid?: boolean;
  errorText?: string;
  maxEmojiCount?: number;
  hideCounter?: boolean;
}

export function EmojiInput({
  value = '',
  onChange,
  label,
  placeholder,
  required = false,
  invalid = false,
  errorText,
  maxEmojiCount = 4,
  hideCounter = false,
}: EmojiInputProps) {
  const isDarkMode = useIsDarkMode();
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [triggerEvent, setTriggerEvent] = useState<Event | undefined>();
  const [popoverSide, setPopoverSide] = useState<'top' | 'bottom'>('bottom');
  const [pickerHeight, setPickerHeight] = useState(350);

  const handleEmojiClick = useCallback(
    (emojiData: EmojiClickData) => {
      const currentEmojis = extractEmojiSequences(value);
      if (currentEmojis.length >= maxEmojiCount) return;

      const nextEmojis = [...currentEmojis, emojiData.emoji];
      onChange(nextEmojis.slice(0, maxEmojiCount).join(''));
    },
    [value, maxEmojiCount, onChange],
  );

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLIonInputElement>) => {
    if (event.nativeEvent.isComposing || event.key.length > 1 || event.ctrlKey || event.metaKey) {
      return;
    }
    if (!isEmojiSequence(event.key)) {
      event.preventDefault();
    }
  }, []);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLIonInputElement>) => {
      event.preventDefault();

      const pastedText = event.clipboardData.getData('text');
      if (!pastedText) return;

      const validEmojis = extractEmojiSequences(pastedText);
      if (validEmojis.length === 0) return;

      const currentEmojis = extractEmojiSequences(value);
      const newEmojis = [...currentEmojis, ...validEmojis].slice(0, maxEmojiCount);
      onChange(newEmojis.join(''));
    },
    [value, maxEmojiCount, onChange],
  );

  const handleIonInput = useCallback(
    (event: Event) => {
      const customEvent = event as CustomEvent;
      const target = event.target as HTMLIonInputElement;
      const rawValue = customEvent.detail.value ?? '';

      const cleanValue = rawValue.replace(/\s+/g, '');
      const validEmojis = extractEmojiSequences(cleanValue);
      const finalValue = validEmojis.slice(0, maxEmojiCount).join('');

      if (rawValue !== finalValue) {
        target.value = finalValue;
      }

      onChange(finalValue);
    },
    [maxEmojiCount, onChange],
  );

  const handleOpenPicker = useCallback((event: React.MouseEvent<HTMLIonButtonElement>) => {
    const y = event.clientY;
    const vh = window.innerHeight;
    const margin = 24;
    const openUp = y > vh / 2;

    setPopoverSide(openUp ? 'top' : 'bottom');
    setPickerHeight(Math.min(350, Math.max(200, (openUp ? y : vh - y) - margin)));
    setTriggerEvent(event.nativeEvent);
    setIsPickerOpen(true);
  }, []);

  return (
    <>
      <div className={styles.fieldRow}>
        <IonInput
          value={value}
          {...(label && { label: `${label}${required ? ' *' : ''}`, labelPlacement: 'stacked' })}
          placeholder={placeholder}
          counter={!hideCounter}
          maxlength={maxEmojiCount * 10}
          counterFormatter={() => (hideCounter ? '' : `${extractEmojiSequences(value).length} / ${maxEmojiCount}`)}
          errorText={errorText ?? t`Please choose at least one emoji`}
          className={`${styles.input}${invalid ? ' ion-invalid ion-touched' : ''} ${hideCounter ? styles.noCounter : ''}`}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onIonInput={handleIonInput}
        />
        <IonButton
          type="button"
          fill="clear"
          aria-label={t`Open emoji picker`}
          className={hideCounter ? undefined : styles.triggerButton}
          onClick={handleOpenPicker}
        >
          <IonIcon slot="icon-only" icon={happyOutline} />
        </IonButton>
      </div>

      <IonPopover
        isOpen={isPickerOpen}
        event={triggerEvent}
        onDidDismiss={() => {
          setIsPickerOpen(false);
          setTriggerEvent(undefined);
        }}
        alignment="end"
        side={popoverSide}
        className={styles.popover}
      >
        <div className={styles.pickerCard}>
          <EmojiPicker
            onEmojiClick={handleEmojiClick}
            theme={isDarkMode ? Theme.DARK : Theme.LIGHT}
            emojiStyle={EmojiStyle.NATIVE}
            lazyLoadEmojis
            searchPlaceholder={t`Search emoji`}
            previewConfig={{ showPreview: false }}
            skinTonesDisabled
            width="100%"
            height={pickerHeight}
          />
        </div>
      </IonPopover>
    </>
  );
}
