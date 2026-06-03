import { useMemo, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { IonIcon } from '@ionic/react';
import {
  arrowRedoOutline,
  arrowUndo,
  chatbubbles,
  checkmarkCircle,
  checkmarkCircleOutline,
  documentOutline,
  femaleOutline,
  maleOutline,
} from 'ionicons/icons';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useSelector } from 'react-redux';
import styles from './ChatBubble.module.scss';
import reactionStyles from './ReactionPill.module.scss';
import type { Attachment, MentionInfo, ReplyToMessage, ReactionSummary, UserGroupTagInfo } from '@/api/messages';
import { ImageViewer } from '@/components/chat/messages/media/ImageViewer';
import { formatMessagePreview, type PreviewMessage, getNotificationPreviewLabels } from '@/utils/messagePreview';
import { selectChatFontSizeStyle, selectEffectiveLocale } from '@/store/settingsSlice';
import { UserAvatar } from '@/components/UserAvatar';
import { useMouseDetected } from '@/hooks/platformHooks';
import { parseInviteCodeFromUrl } from '@/utils/inviteUrl';
import { decodePermalink } from '@/utils/permalinkUrl';
import { VoiceMessageBubble } from './VoiceMessageBubble';
import { InviteLinkInline } from './InviteLinkInline';
import { PermalinkInline } from './PermalinkInline';
import { ReactionPill } from './ReactionPill';
import { SingleMediaAttachment } from './media/SingleMediaAttachment';
import { JustifiedMediaGallery } from './media/JustifiedMediaGallery';
import { VideoPreview } from './media/VideoPreview';
import { DisplayableImage } from '@/components/shared/DisplayableImage';
import { isHeicLikeMedia } from '@/utils/heicMedia';
import {
  parseChatBubbleContentToRichItems,
  getMessageLayoutStats,
  URL_REGEX,
  TRAILING_PUNCT,
  getChatBaseFont,
  getChatBubbleMaxWidth,
  MENTION_TEST,
  MENTION_REGEX,
} from '@/utils/chatTextMeasure';

const PERMALINK_PATH_RE = /^\/m\/([A-Za-z0-9_-]+)$/;

function parsePermalinkFromUrl(url: string): { chatId: string; messageId: string; encoded: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== document.location.origin) return null;
    const match = PERMALINK_PATH_RE.exec(parsed.pathname);
    if (!match) return null;
    const encoded = match[1];
    const { chatId, messageId } = decodePermalink(encoded);
    return { chatId, messageId, encoded };
  } catch {
    return null;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function isImageAttachment(attachment: Attachment) {
  return (
    attachment.kind.startsWith('image/') ||
    isHeicLikeMedia({
      mimeType: attachment.kind,
      fileName: attachment.fileName,
      url: attachment.url,
    })
  );
}

function isVideoAttachment(attachment: Attachment) {
  return attachment.kind.startsWith('video/');
}

function renderMessageWithLinks(message: string): ReactNode[] {
  const parts = message.split(URL_REGEX);
  if (parts.length === 1) return [message];

  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const trimmed = part.replace(TRAILING_PUNCT, '');
      const suffix = part.slice(trimmed.length);
      const inviteCode = parseInviteCodeFromUrl(trimmed);
      const permalink = !inviteCode ? parsePermalinkFromUrl(trimmed) : null;
      return (
        <span key={i}>
          {inviteCode ? (
            <InviteLinkInline code={inviteCode} url={trimmed} />
          ) : permalink ? (
            <PermalinkInline
              targetChatId={permalink.chatId}
              targetMessageId={permalink.messageId}
              encoded={permalink.encoded}
              url={trimmed}
            />
          ) : (
            <a
              href={trimmed}
              className={styles.messageLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {trimmed}
            </a>
          )}
          {suffix}
        </span>
      );
    }

    return part;
  });
}

function renderMessageContent(
  message: string,
  mentions: MentionInfo[] | undefined,
  currentUserUid: number | null | undefined,
  onMentionClick: ((uid: number) => void) | undefined,
): ReactNode[] {
  if (!MENTION_TEST.test(message)) {
    return renderMessageWithLinks(message);
  }

  const mentionMap = new Map<number, string>();
  if (mentions) {
    for (const m of mentions) {
      if (m.username) mentionMap.set(m.uid, m.username);
    }
  }

  const regex = new RegExp(MENTION_REGEX);
  const result: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(message)) !== null) {
    if (match.index > lastIndex) {
      result.push(...renderMessageWithLinks(message.slice(lastIndex, match.index)));
    }

    const uid = parseInt(match[1], 10);
    const username = mentionMap.get(uid);
    const isSelf = currentUserUid != null && uid === currentUserUid;
    const clickable = onMentionClick != null;
    result.push(
      <span
        key={`mention-${uid}-${match.index}`}
        className={`${styles.mention}${isSelf ? ` ${styles.mentionSelf}` : ''}${clickable ? ` ${styles.mentionClickable}` : ''}`}
        onClick={
          clickable
            ? (e) => {
                e.stopPropagation();
                onMentionClick(uid);
              }
            : undefined
        }
      >
        @{username ?? `User ${uid}`}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < message.length) {
    result.push(...renderMessageWithLinks(message.slice(lastIndex)));
  }

  return result;
}

function getImageLayoutStyle(
  width: number | null | undefined,
  height: number | null | undefined,
  maxImageHeight: number,
): CSSProperties | undefined {
  if (!width || !height || width <= 0 || height <= 0) {
    return undefined;
  }

  const aspectRatio = width / height;
  const imageStyle: CSSProperties = {
    aspectRatio: `${width} / ${height}`,
  };

  if (height > maxImageHeight) {
    imageStyle.width = Math.min(width, maxImageHeight * aspectRatio);
  } else {
    imageStyle.width = width;
  }

  return imageStyle;
}

export type BubblePropsOverride = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className' | 'style'> & {
  className?: string;
  style?: CSSProperties;
  [dataAttr: `data-${string}`]: string | undefined;
};

export interface ChatBubbleBaseProps {
  messageType?: 'text' | 'audio';
  senderName: string;
  senderGender?: number;
  senderGroup?: UserGroupTagInfo | null;
  message: string;
  isSent: boolean;
  avatarUrl?: string;
  showName?: boolean;
  showAvatar?: boolean;
  onReply?: () => void;
  onReplyTap?: () => void;
  onAvatarClick?: () => void;
  replyTo?: {
    senderName: string;
    preview: PreviewMessage;
  };
  timestamp?: string;
  edited?: boolean;
  isConfirmed?: boolean;
  threadInfo?: { replyCount: number };
  onThreadClick?: () => void;
  attachments?: Attachment[];
  maxImageHeight?: number;
  reactions?: ReactionSummary[];
  onReactionToggle?: (emoji: string, currentlyReacted: boolean) => void;
  layout?: 'thread' | 'bubble-only';
  interactionMode?: 'interactive' | 'read-only';
  bubbleProps?: BubblePropsOverride;
  bubbleRef?: Ref<HTMLDivElement>;
  mentions?: MentionInfo[];
  currentUserUid?: number | null;
  onMentionClick?: (uid: number) => void;
  forwardedFrom?: {
    sender: { name: string | null };
    originalReplyTo?: ReplyToMessage;
  } | null;
}

export function ChatBubbleBase({
  messageType = 'text',
  senderName,
  senderGender,
  senderGroup,
  message,
  isSent,
  avatarUrl,
  showName = true,
  showAvatar = true,
  onReply,
  onReplyTap,
  onAvatarClick,
  replyTo,
  timestamp,
  edited,
  isConfirmed,
  threadInfo,
  onThreadClick,
  attachments,
  maxImageHeight = 300,
  reactions,
  onReactionToggle,
  layout = 'thread',
  interactionMode = 'interactive',
  bubbleProps,
  bubbleRef,
  mentions,
  currentUserUid,
  onMentionClick,
  forwardedFrom,
}: ChatBubbleBaseProps) {
  const [viewingAttachmentIndex, setViewingAttachmentIndex] = useState<number | null>(null);
  const mouseDetected = useMouseDetected();
  const chatFontSizeStyle = useSelector(selectChatFontSizeStyle);
  const locale = useSelector(selectEffectiveLocale);
  const interactive = interactionMode === 'interactive';
  const imageAttachments = attachments?.filter((att) => isImageAttachment(att) || isVideoAttachment(att)) ?? [];
  const otherAttachments = attachments?.filter((att) => !(isImageAttachment(att) || isVideoAttachment(att))) ?? [];
  const { className: bubbleClassName, style: bubbleStyle, ...bubbleRestProps } = bubbleProps ?? {};

  const hasTopContent = showName || replyTo || !!forwardedFrom;
  const hasBottomContent = message && message.trim() !== '';
  const isMediaOnly = imageAttachments.length > 0 && !hasBottomContent && otherAttachments.length === 0;

  const baseFont = getChatBaseFont(chatFontSizeStyle as string);

  const layoutStats = useMemo(() => {
    if (messageType === 'text' && hasBottomContent) {
      try {
        const items = parseChatBubbleContentToRichItems(message, mentions, baseFont);
        return getMessageLayoutStats(items, getChatBubbleMaxWidth());
      } catch {
        return undefined;
      }
    }
    return undefined;
  }, [messageType, hasBottomContent, message, mentions, baseFont]);

  const mediaContainerClasses = [
    styles.attachmentsContainer,
    (styles as any).edgeToEdgeHorizontal,
    !hasTopContent ? (styles as any).edgeToEdgeTop : (styles as any).hasTopContent,
    !hasBottomContent ? (styles as any).edgeToEdgeBottom : (styles as any).hasBottomContent,
  ]
    .filter(Boolean)
    .join(' ');

  function logAttachmentLoad(
    kind: 'image' | 'video',
    attachment: Attachment,
    element: HTMLImageElement | HTMLVideoElement,
  ) {
    if (!import.meta.env.DEV) return;

    const rect = element.getBoundingClientRect();
    console.log('[ChatBubble] attachment-load', {
      kind,
      attachmentId: attachment.id,
      attachmentKind: attachment.kind,
      src: attachment.url,
      metaWidth: attachment.width ?? null,
      metaHeight: attachment.height ?? null,
      renderedWidth: Math.round(rect.width),
      renderedHeight: Math.round(rect.height),
      naturalWidth: 'naturalWidth' in element ? element.naturalWidth : element.videoWidth,
      naturalHeight: 'naturalHeight' in element ? element.naturalHeight : element.videoHeight,
    });
  }

  const isOnlyAttachment = attachments?.length === 1;

  const renderMediaItem = (att: Attachment, style?: CSSProperties) => {
    if (att.kind.startsWith('video/')) {
      return (
        <VideoPreview
          src={att.url}
          style={style}
          autoPlay={isOnlyAttachment}
          showPlayButton={!isOnlyAttachment}
          onLoaded={(el) => logAttachmentLoad('video', att, el)}
        />
      );
    }
    return (
      <DisplayableImage
        src={att.url}
        mimeType={att.kind}
        fileName={att.fileName}
        alt={t`Attachment`}
        style={style}
        onLoad={(e) => logAttachmentLoad('image', att, e.currentTarget)}
      />
    );
  };

  function renderAttachment(att: Attachment) {
    if (isImageAttachment(att)) {
      const imageLayoutStyle = getImageLayoutStyle(att.width, att.height, maxImageHeight);
      const imageContainerStyle: CSSProperties = {
        maxHeight: maxImageHeight,
        ...(imageLayoutStyle ?? {}),
      };

      const image = (
        <DisplayableImage
          src={att.url}
          mimeType={att.kind}
          fileName={att.fileName}
          alt={t`Attachment`}
          className={styles.attachmentImage}
          style={imageLayoutStyle ? undefined : { maxHeight: maxImageHeight }}
          onLoad={(event) => {
            logAttachmentLoad('image', att, event.currentTarget);
          }}
        />
      );

      if (!interactive) {
        return (
          <div key={att.id} className={styles.attachmentStatic} style={imageContainerStyle}>
            {image}
          </div>
        );
      }

      return (
        <button
          key={att.id}
          type="button"
          className={styles.attachmentImageButton}
          style={imageContainerStyle}
          onClick={() => {
            const imageIndex = imageAttachments.findIndex((imageAttachment) => imageAttachment.id === att.id);
            setViewingAttachmentIndex(imageIndex >= 0 ? imageIndex : 0);
          }}
        >
          {image}
        </button>
      );
    }

    if (att.kind.startsWith('video/')) {
      const imageLayoutStyle = getImageLayoutStyle(att.width, att.height, maxImageHeight);
      const imageContainerStyle: CSSProperties = {
        maxHeight: maxImageHeight,
        ...(imageLayoutStyle ?? {}),
      };

      const video = (
        <VideoPreview
          src={att.url}
          className={styles.attachmentImage}
          style={imageLayoutStyle ? undefined : { maxHeight: maxImageHeight }}
          autoPlay={isOnlyAttachment}
          showPlayButton={!isOnlyAttachment}
          onLoaded={(el) => logAttachmentLoad('video', att, el)}
        />
      );

      if (!interactive) {
        return (
          <div key={att.id} className={styles.attachmentStatic} style={imageContainerStyle}>
            {video}
          </div>
        );
      }

      return (
        <button
          key={att.id}
          type="button"
          rel="noopener noreferrer"
          className={styles.attachmentImageButton}
          style={imageContainerStyle}
          onClick={() => {
            const imageIndex = imageAttachments.findIndex((imageAttachment) => imageAttachment.id === att.id);
            setViewingAttachmentIndex(imageIndex >= 0 ? imageIndex : 0);
          }}
        >
          {video}
        </button>
      );
    }

    if (att.kind.startsWith('audio/')) {
      if (messageType === 'audio') {
        return <VoiceMessageBubble key={att.id} src={att.url} />;
      }

      if (!interactive) {
        return (
          <div key={att.id} className={styles.filePlaceholder}>
            <IonIcon icon={documentOutline} className={styles.fileIcon} />
            <span className={styles.fileName}>{att.fileName}</span>
          </div>
        );
      }

      return (
        <a key={att.id} className={styles.filePlaceholder} href={att.url} target="_blank" rel="noopener noreferrer">
          <IonIcon icon={documentOutline} className={styles.fileIcon} />
          <span className={styles.fileName}>{att.fileName}</span>
        </a>
      );
    }

    if (!interactive) {
      return (
        <div key={att.id} className={styles.filePlaceholder}>
          <IonIcon icon={documentOutline} className={styles.fileIcon} />
          <span className={styles.fileName}>{att.fileName}</span>
        </div>
      );
    }

    return (
      <a key={att.id} className={styles.filePlaceholder} href={att.url} target="_blank" rel="noopener noreferrer">
        <IonIcon icon={documentOutline} className={styles.fileIcon} />
        <span className={styles.fileName}>{att.fileName}</span>
      </a>
    );
  }

  const bubble = (
    <div
      ref={bubbleRef}
      {...bubbleRestProps}
      className={[styles.bubble, mouseDetected ? styles.mouseSelectable : '', bubbleClassName]
        .filter(Boolean)
        .join(' ')}
      style={{ fontSize: chatFontSizeStyle, ...bubbleStyle }}
    >
      {showName && (
        <div className={styles.sender}>
          <span className={styles.senderName}>{senderName}</span>
          {senderGroup && (
            <span className={styles.senderGroup} color={senderGroup.chatGroupColor!}>
              {senderGroup.name}
            </span>
          )}
          {senderGender != null &&
            (senderGender === 2 ? (
              <IonIcon icon={femaleOutline} className={`${styles.gender} ${styles.gender2}`} />
            ) : (
              <IonIcon icon={maleOutline} className={`${styles.gender} ${styles.gender1}`} />
            ))}
        </div>
      )}
      {forwardedFrom && (
        <div className={styles.forwardedLabel}>
          <IonIcon icon={arrowRedoOutline} className={styles.forwardedIcon} />
          <span>
            <Trans>Forwarded from {forwardedFrom.sender.name || 'Unknown'}</Trans>
          </span>
        </div>
      )}
      {forwardedFrom?.originalReplyTo && (
        <div className={styles.replyPreview}>
          <div className={styles.replyPreviewName}>{forwardedFrom.originalReplyTo.sender.name ?? 'Unknown'}</div>
          <div className={styles.replyPreviewText}>
            {formatMessagePreview(forwardedFrom.originalReplyTo, getNotificationPreviewLabels(locale))}
          </div>
        </div>
      )}
      {replyTo && (
        <div
          className={`${styles.replyPreview} ${interactive && onReplyTap ? styles.replyPreviewTappable : ''}`}
          onClick={interactive ? onReplyTap : undefined}
        >
          <div className={styles.replyPreviewName}>{replyTo.senderName}</div>
          <div className={styles.replyPreviewText}>
            {formatMessagePreview(replyTo.preview, getNotificationPreviewLabels(locale))}
          </div>
        </div>
      )}
      {imageAttachments.length > 0 && (
        <div className={mediaContainerClasses}>
          {imageAttachments.length === 1 ? (
            <SingleMediaAttachment
              attachment={imageAttachments[0]}
              interactive={interactive}
              onView={() => setViewingAttachmentIndex(0)}
              renderElement={(style) => renderMediaItem(imageAttachments[0], style)}
            />
          ) : (
            <JustifiedMediaGallery
              attachments={imageAttachments}
              interactive={interactive}
              onView={(id) => {
                const index = imageAttachments.findIndex((a) => a.id === id);
                setViewingAttachmentIndex(index >= 0 ? index : 0);
              }}
              renderElement={(id, style) => renderMediaItem(imageAttachments.find((a) => a.id === id)!, style)}
            />
          )}
          {isMediaOnly && timestamp && (
            <span className={(styles as any).mediaTimestamp}>
              {formatTime(timestamp)}
              {edited && ` (${t`Edited`})`}
              {isSent && (
                <IonIcon icon={isConfirmed ? checkmarkCircle : checkmarkCircleOutline} className={styles.statusIcon} />
              )}
            </span>
          )}
        </div>
      )}
      {otherAttachments.length > 0 && (
        <div className={styles.attachmentsContainer}>{otherAttachments.map(renderAttachment)}</div>
      )}
      {(hasBottomContent || !isMediaOnly) && (
        <div
          className={styles.messageWrapper}
          style={
            layoutStats && layoutStats.lineCount > 1
              ? { width: `min(100%, ${Math.ceil(layoutStats.maxLineWidth) + 12}px)` }
              : undefined
          }
        >
          {hasBottomContent && (
            <span className={styles.messageText}>
              {renderMessageContent(message, mentions, currentUserUid, interactive ? onMentionClick : undefined)}
            </span>
          )}
          <span className={styles.timestampSpacer} />
          {timestamp && (
            <span className={styles.timestamp}>
              {formatTime(timestamp)}
              {edited && ` (${t`Edited`})`}
              {isSent && (
                <IonIcon icon={isConfirmed ? checkmarkCircle : checkmarkCircleOutline} className={styles.statusIcon} />
              )}
            </span>
          )}
        </div>
      )}
      {threadInfo && (
        <div className={styles.threadIndicator} onClick={interactive ? onThreadClick : undefined}>
          <IonIcon icon={chatbubbles} />
          <span>
            {threadInfo.replyCount} {threadInfo.replyCount === 1 ? t`reply` : t`replies`}
          </span>
        </div>
      )}
    </div>
  );

  const sortedReactions = reactions
    ? [...reactions].sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.emoji.localeCompare(b.emoji);
      })
    : [];

  const reactionsContent = sortedReactions.length > 0 && (
    <div
      className={`${reactionStyles.reactionsContainer} ${isSent ? reactionStyles.reactionsContainerSent : ''}`.trim()}
    >
      {sortedReactions.map((reaction) => (
        <ReactionPill
          key={reaction.emoji}
          reaction={reaction}
          isSent={isSent}
          interactive={interactive}
          onToggle={onReactionToggle}
        />
      ))}
    </div>
  );

  if (layout === 'bubble-only') {
    return (
      <div className={`${styles.bubbleOnly} ${isSent ? styles.sent : styles.received}`}>
        <div className={styles.bubbleWrapper}>
          {bubble}
          {reactionsContent}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`${styles.chatRow} ${isSent ? styles.sent : styles.received}`}>
        {showAvatar ? (
          <UserAvatar
            name={senderName}
            avatarUrl={avatarUrl}
            size={36}
            className={styles.avatar}
            onClick={interactive ? onAvatarClick : undefined}
          />
        ) : (
          <div className={styles.avatarSpacer} />
        )}
        <div className={styles.bubbleWrapper}>
          {bubble}
          {reactionsContent}
        </div>
        {interactive && onReply && (
          <button className={styles.hoverReplyBtn} onClick={onReply} aria-label={t`Reply`}>
            <IonIcon icon={arrowUndo} />
          </button>
        )}
      </div>
      {interactive && viewingAttachmentIndex !== null && imageAttachments.length > 0 && (
        <ImageViewer
          images={imageAttachments.map((image) => ({
            id: image.id,
            kind: image.kind,
            src: image.url,
            fileName: image.fileName,
            width: image.width,
            height: image.height,
          }))}
          initialIndex={viewingAttachmentIndex}
          onClose={() => setViewingAttachmentIndex(null)}
        />
      )}
    </>
  );
}
