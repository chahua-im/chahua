import { type ImgHTMLAttributes, type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { convertHeicSourceToWebpBlob } from '@/utils/compression';
import { isHeicLikeMedia } from '@/utils/fileType';

interface DisplayableImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  mimeType?: string | null;
  fileName?: string | null;
}

export function DisplayableImage({ src, mimeType, fileName, onError, ...imgProps }: DisplayableImageProps) {
  return (
    <DisplayableImageInner
      key={src}
      src={src}
      mimeType={mimeType}
      fileName={fileName}
      onError={onError}
      {...imgProps}
    />
  );
}

function DisplayableImageInner({ src, mimeType, fileName, onError, ...imgProps }: DisplayableImageProps) {
  const heicLike = isHeicLikeMedia({ mimeType, fileName, url: src });
  const [displaySrc, setDisplaySrc] = useState(src);
  const [isResolving, setIsResolving] = useState(false);
  const mountedRef = useRef(true);
  const conversionStartedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleError = (event: SyntheticEvent<HTMLImageElement, Event>) => {
    if (!heicLike || conversionStartedRef.current) {
      onError?.(event);
      return;
    }

    conversionStartedRef.current = true;
    setIsResolving(true);
    void convertHeicSourceToWebpBlob(src)
      .then((blob) => {
        if (!mountedRef.current) return;
        setDisplaySrc(URL.createObjectURL(blob));
        setIsResolving(false);
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        setIsResolving(false);
        onError?.(event);
        console.warn('[media:heic] Failed to convert HEIC preview', {
          src,
          mimeType,
          fileName,
          error,
        });
      });
  };

  useEffect(() => {
    if (displaySrc === src) return;
    return () => URL.revokeObjectURL(displaySrc);
  }, [displaySrc, src]);

  return (
    <img
      {...imgProps}
      src={displaySrc}
      onError={handleError}
      style={{ opacity: isResolving ? 0 : 1, ...imgProps.style }}
    />
  );
}
