import { useState, useRef } from 'react';
import { useIonToast } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { uploadStickerToPack, MAX_STICKER_FILE_BYTES, type StickerSummary } from '@/api/stickers';
import { categorizeAttachmentKind, detectFileMimeType, isHeicLikeMedia, normalizeMimeType } from '@/utils/fileType';

interface UseAddStickerOptions {
  packId?: string;
  onSuccess: (newSticker: StickerSummary) => void;
}

export function useAddSticker({ packId, onSuccess }: UseAddStickerOptions) {
  const [addStickerFile, setAddStickerFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [presentToast] = useIonToast();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_STICKER_FILE_BYTES) {
      presentToast({
        message: t`File is too large. Maximum sticker size is 10 MB.`,
        duration: 3000,
        position: 'bottom',
        cssClass: 'toast-center',
      });
      return;
    }

    const contentType = await detectFileMimeType(file);
    const isAllowed =
      (categorizeAttachmentKind(contentType) === 'image' &&
        !isHeicLikeMedia({ mimeType: contentType, fileName: file.name })) ||
      normalizeMimeType(contentType) === 'video/webm';
    if (!isAllowed) {
      presentToast({
        message: t`Stickers must be an image or a WebM video.`,
        duration: 3000,
        position: 'bottom',
        cssClass: 'toast-center',
      });
      return;
    }

    setAddStickerFile(contentType === file.type ? file : new File([file], file.name, { type: contentType }));
  };

  const handleAddSticker = async (file: File, emoji: string, name: string) => {
    if (!packId) return;
    try {
      const res = await uploadStickerToPack(packId, { file, emoji, name });
      setAddStickerFile(null);
      presentToast({ message: t`Sticker added`, duration: 1500, position: 'bottom' });
      onSuccess(res.data);
    } catch (error) {
      console.error('Failed to add sticker', error);
      presentToast({ message: t`Failed to add sticker`, duration: 2000, position: 'bottom' });
    }
  };

  return {
    addStickerFile,
    setAddStickerFile,
    fileInputRef,
    handleFileChange,
    handleAddSticker,
  };
}
