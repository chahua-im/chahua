import { useMemo, useState, type CSSProperties, type HTMLAttributes, type Ref } from 'react';
import { IonIcon } from '@ionic/react';
import { chatbubbles, checkmarkCircle, checkmarkCircleOutline, femaleOutline, maleOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { useSelector } from 'react-redux';
import styles from './ChatBubble.module.scss';
import { HoverReplyButton } from './HoverReplyButton';
import reactionStyles from './ReactionPill.module.scss';
import { formatTime } from '@/utils/formatTime';
import type { Attachment, MentionInfo, ReactionSummary, UserGroupTagInfo } from '@/api/messages';
import { ImageViewer } from '@/components/chat/messages/media/ImageViewer';
import { type PreviewMessage } from '@/utils/messagePreview';
import { selectChatFontSizeStyle } from '@/store/settingsSlice';
import { UserAvatar } from '@/components/UserAvatar';
import { ReplyPreview } from './ReplyPreview';
import { useIsDarkMode, useMouseDetected } from '@/hooks/platformHooks';
import { colorForUser } from '@/utils/userColor';
import { VoiceMessageBubble } from './VoiceMessageBubble';
import { renderMessageContent } from './messageContent';
import { ReactionPill } from './ReactionPill';
import { SingleMediaAttachment } from './media/SingleMediaAttachment';
import { JustifiedMediaGallery } from './media/JustifiedMediaGallery';
import { VideoPreview } from './media/VideoPreview';
import { DisplayableImage } from '@/components/shared/DisplayableImage';
import { FileAttachmentCard } from './FileAttachmentCard';
import {
  parseChatBubbleContentToRichItems,
  getMessageLayoutStats,
  getChatBaseFont,
  getChatBubbleMaxWidth,
} from '@/utils/chatTextMeasure';

export type BubblePropsOverride = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className' | 'style'> & {
  className?: string;
  style?: CSSProperties;
  [dataAttr: `data-${string}`]: string | undefined;
};

export interface ChatBubbleBaseProps {
  messageType?: 'text' | 'audio' | 'file';
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
  reactions?: ReactionSummary[];
  onReactionToggle?: (emoji: string, currentlyReacted: boolean) => void;
  reactionsInteractive?: boolean;
  layout?: 'thread' | 'bubble-only';
  interactionMode?: 'interactive' | 'read-only';
  bubbleProps?: BubblePropsOverride;
  bubbleRef?: Ref<HTMLDivElement>;
  mentions?: MentionInfo[];
  currentUserUid?: number | null;
  onMentionClick?: (uid: number) => void;
  showDroplet?: boolean;
  uploadProgress?: number;
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
  reactions,
  onReactionToggle,
  reactionsInteractive,
  layout = 'thread',
  interactionMode = 'interactive',
  bubbleProps,
  bubbleRef,
  mentions,
  currentUserUid,
  onMentionClick,
  showDroplet: showDropletProp,
  uploadProgress,
}: ChatBubbleBaseProps) {
  const [viewingAttachmentIndex, setViewingAttachmentIndex] = useState<number | null>(null);
  const mouseDetected = useMouseDetected();
  const isDarkMode = useIsDarkMode();
  const chatFontSizeStyle = useSelector(selectChatFontSizeStyle);
  const interactive = interactionMode === 'interactive';
  const mediaAttachments = messageType === 'file' || messageType === 'audio' ? [] : (attachments ?? []);
  const imageAttachments = mediaAttachments;
  const { className: bubbleClassName, style: bubbleStyle, ...bubbleRestProps } = bubbleProps ?? {};

  const hasTopContent = showName || replyTo;
  const hasBottomContent = messageType !== 'file' && !!message && message.trim() !== '';
  const isMediaOnly = imageAttachments.length > 0 && !hasBottomContent;
  const showDroplet = (showDropletProp ?? (showAvatar || layout === 'bubble-only')) && !isMediaOnly;

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
    (styles as Record<string, string>).edgeToEdgeHorizontal,
    !hasTopContent
      ? (styles as Record<string, string>).edgeToEdgeTop
      : (styles as Record<string, string>).hasTopContent,
    // When a thread indicator follows the media grid, keep normal bottom spacing so the
    // indicator's divider sits at the grid bottom instead of being pulled into it.
    !hasBottomContent && !threadInfo
      ? (styles as Record<string, string>).edgeToEdgeBottom
      : (styles as Record<string, string>).hasBottomContent,
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

  const senderGroupBadgeStyle = (() => {
    if (isSent || !senderGroup?.chatGroupColor) return undefined;
    const groupColor = isDarkMode
      ? (senderGroup.chatGroupColorDark ?? senderGroup.chatGroupColor)
      : senderGroup.chatGroupColor;
    return {
      backgroundColor: `${groupColor}`,
      color: '#fff',
    } as CSSProperties;
  })();

  const bubble = (
    <div
      ref={bubbleRef}
      {...bubbleRestProps}
      className={[
        styles.bubble,
        mouseDetected ? styles.mouseSelectable : '',
        showDroplet ? (styles as Record<string, string>).droplet : '',
        bubbleClassName,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ fontSize: chatFontSizeStyle, ...bubbleStyle }}
    >
      {showName && (
        <div className={styles.sender}>
          <span
            className={styles.senderName}
            style={isSent ? undefined : { color: colorForUser(senderName, isDarkMode) }}
          >
            {senderName}
          </span>
          {senderGroup && (
            <span className={styles.senderGroup} style={senderGroupBadgeStyle}>
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
      {replyTo && <ReplyPreview replyTo={replyTo} isSent={isSent} interactive={interactive} onReplyTap={onReplyTap} />}
      {messageType === 'file' && (
        <div className={styles.attachmentsContainer}>
          {(attachments ?? []).map((attachment) => (
            <FileAttachmentCard
              key={attachment.id}
              attachment={attachment}
              interactive={interactive}
              uploadProgress={uploadProgress}
            />
          ))}
        </div>
      )}
      {messageType === 'audio' && (
        <div className={styles.attachmentsContainer}>
          {(attachments ?? []).map((attachment) => (
            <VoiceMessageBubble key={attachment.id} src={attachment.url} />
          ))}
        </div>
      )}
      {messageType !== 'file' && messageType !== 'audio' && imageAttachments.length > 0 && (
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
                const index = imageAttachments.findIndex((attachment) => attachment.id === id);
                setViewingAttachmentIndex(index >= 0 ? index : 0);
              }}
              renderElement={(id, style) =>
                renderMediaItem(imageAttachments.find((attachment) => attachment.id === id)!, style)
              }
            />
          )}
          {isMediaOnly && timestamp && (
            <span className={(styles as Record<string, string>).mediaTimestamp}>
              {formatTime(timestamp)}
              {edited && ` (${t`Edited`})`}
              {isSent && (
                <IonIcon icon={isConfirmed ? checkmarkCircle : checkmarkCircleOutline} className={styles.statusIcon} />
              )}
            </span>
          )}
        </div>
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
        <div
          className={`${styles.threadIndicator} ${isMediaOnly ? (styles as Record<string, string>).threadIndicatorMediaOnly : ''}`}
          onClick={interactive ? onThreadClick : undefined}
        >
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
          interactive={reactionsInteractive ?? interactive}
          onToggle={onReactionToggle}
        />
      ))}
    </div>
  );

  if (layout === 'bubble-only') {
    return (
      <div className={`${styles.bubbleOnly} ${isSent ? styles.sent : styles.received}`} data-message-row>
        <div className={styles.bubbleWrapper}>
          {bubble}
          {reactionsContent}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`${styles.chatRow} ${isSent ? styles.sent : styles.received}`} data-message-row>
        <div className={styles.messageColumn}>
          <div className={styles.avatarBubbleRow}>
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
            {bubble}
            <HoverReplyButton interactive={interactive} onReply={onReply} />
          </div>
          {reactionsContent}
        </div>
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
