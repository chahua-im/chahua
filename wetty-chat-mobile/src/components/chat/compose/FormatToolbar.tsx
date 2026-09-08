import { useRef, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { linkOutline } from 'ionicons/icons';
import type { TextFormatKind } from '@/utils/textFormat';
import styles from './FormatToolbar.module.scss';

/** Viewport-space point the toolbar should hover above (textarea top-centre). */
export interface FormatToolbarAnchor {
  top: number;
  left: number;
}

interface FormatToolbarProps {
  anchor: FormatToolbarAnchor;
  /** Link popup visibility; owned by the composer so the toolbar survives the popup input stealing focus. */
  linkMode: boolean;
  onRequestLinkMode: (open: boolean) => void;
  /** Inline/block formatting actions; `link` is handled via the URL popup. */
  onFormat: (kind: Exclude<TextFormatKind, 'link'>) => void;
  /** Raw (still unsanitised) URL typed by the user. */
  onSubmitLink: (url: string) => void;
}

/**
 * Floating formatting pill (bold / italic / strike / underline / code / quote /
 * link) shown next to the textarea while text is selected. Mousedowns are
 * prevented from defaulting so the textarea never loses its selection.
 */
export function FormatToolbar({ anchor, linkMode, onRequestLinkMode, onFormat, onSubmitLink }: FormatToolbarProps) {
  const [draftUrl, setDraftUrl] = useState('');
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  const openLinkMode = () => {
    setDraftUrl('https://');
    onRequestLinkMode(true);
    const focusUrlInput = () => urlInputRef.current?.focus();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(focusUrlInput);
    } else {
      window.setTimeout(focusUrlInput, 0);
    }
  };

  const closeLinkMode = () => {
    onRequestLinkMode(false);
  };

  const submitLink = () => {
    const url = draftUrl.trim();
    if (!url) return;
    onSubmitLink(url);
    onRequestLinkMode(false);
  };

  return (
    <div
      className={styles.toolbar}
      style={{ top: anchor.top, left: anchor.left }}
      data-format-toolbar
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className={styles.button}
        title={t`Bold (Ctrl+B)`}
        aria-label={t`Bold (Ctrl+B)`}
        onClick={() => onFormat('bold')}
        data-format-bold
      >
        <span className={styles.boldGlyph}>B</span>
      </button>
      <button
        type="button"
        className={styles.button}
        title={t`Italic (Ctrl+I)`}
        aria-label={t`Italic (Ctrl+I)`}
        onClick={() => onFormat('italic')}
        data-format-italic
      >
        <span className={styles.italicGlyph}>I</span>
      </button>
      <button
        type="button"
        className={styles.button}
        title={t`Strikethrough (Ctrl+D)`}
        aria-label={t`Strikethrough (Ctrl+D)`}
        onClick={() => onFormat('strike')}
        data-format-strike
      >
        <span className={styles.strikeGlyph}>S</span>
      </button>
      <button
        type="button"
        className={styles.button}
        title={t`Underline (Ctrl+U)`}
        aria-label={t`Underline (Ctrl+U)`}
        onClick={() => onFormat('underline')}
        data-format-underline
      >
        <span className={styles.underlineGlyph}>U</span>
      </button>
      <button
        type="button"
        className={styles.button}
        title={t`Code block`}
        aria-label={t`Code block`}
        onClick={() => onFormat('code')}
        data-format-code
      >
        <span className={styles.codeGlyph}>{'</>'}</span>
      </button>
      <button
        type="button"
        className={styles.button}
        title={t`Quote (Ctrl+Q)`}
        aria-label={t`Quote (Ctrl+Q)`}
        onClick={() => onFormat('quote')}
        data-format-quote
      >
        <span className={styles.quoteGlyph}>&quot;</span>
      </button>
      <button
        type="button"
        className={styles.button}
        title={t`Link`}
        aria-label={t`Link`}
        aria-pressed={linkMode}
        onClick={openLinkMode}
        data-format-link
      >
        <IonIcon icon={linkOutline} className={styles.linkIcon} />
      </button>

      {linkMode && (
        <div className={styles.popup} data-format-url-popup>
          <input
            ref={urlInputRef}
            className={styles.urlInput}
            type="text"
            inputMode="url"
            placeholder="https://example.com"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeLinkMode();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                submitLink();
              }
            }}
            data-format-url-input
          />
          <button type="button" className={styles.popupBtn} onClick={submitLink} data-format-url-apply>
            {t`Add`}
          </button>
          <button type="button" className={styles.popupCancel} onClick={closeLinkMode} data-format-url-cancel>
            {t`Cancel`}
          </button>
        </div>
      )}
    </div>
  );
}
