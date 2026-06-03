import type { AxiosResponse } from 'axios';
import type { StickerSummary } from './stickers';
import apiClient from './client';

export interface UserGroupTagInfo {
  groupId: number;
  name?: string | null;
  chatGroupColor?: string | null;
  chatGroupColorDark?: string | null;
}

export interface User {
  uid: number;
  avatarUrl?: string | null;
  name: string | null;
  gender: number;
  userGroup?: UserGroupTagInfo | null;
}

export type MessageType = 'text' | 'audio' | 'file' | 'system' | 'invite' | 'sticker';

export interface MessagePreviewSticker {
  emoji?: string | null;
}

export interface MessagePreview {
  id: string;
  clientGeneratedId?: string | null;
  createdAt?: string | null;
  message: string | null;
  messageType: MessageType;
  sticker?: MessagePreviewSticker | null;
  sender: User;
  isDeleted: boolean;
  attachments?: Attachment[];
  firstAttachmentKind?: string | null;
  mentions?: MentionInfo[] | null;
}

export type ReplyToMessage = MessagePreview;

export interface Attachment {
  id: string;
  url: string;
  kind: string;
  size: number;
  fileName: string;
  width?: number | null;
  height?: number | null;
}

export interface ThreadInfo {
  replyCount: number;
}

export interface ReactionReactor {
  uid: number;
  name: string | null;
  avatarUrl?: string;
  sortIndex?: number;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reactedByMe?: boolean;
  reactors?: ReactionReactor[];
}

export interface MentionInfo {
  uid: number;
  username: string | null;
  avatarUrl?: string;
  gender: number;
  userGroup?: UserGroupTagInfo | null;
}

export interface ReactionDetailResponse {
  reactions: { emoji: string; reactors: ReactionReactor[] }[];
}

export interface MarkChatReadStateResponse {
  lastReadMessageId: string | null;
  unreadCount: number;
}

export interface MessageResponse {
  id: string;
  message: string | null;
  messageType: MessageType;
  sticker?: StickerSummary;
  replyRootId: string | null;
  clientGeneratedId: string;
  sender: User;
  chatId: string;
  createdAt: string;
  isEdited: boolean;
  isDeleted: boolean;
  hasAttachments: boolean;
  threadInfo?: ThreadInfo;
  replyToMessage?: ReplyToMessage;
  attachments?: Attachment[];
  reactions?: ReactionSummary[];
  mentions?: MentionInfo[];
}

export function toMessagePreview(message: MessageResponse): MessagePreview {
  return {
    id: message.id,
    clientGeneratedId: message.clientGeneratedId,
    createdAt: message.createdAt,
    message: message.message,
    messageType: message.messageType,
    sticker: message.sticker ? { emoji: message.sticker.emoji } : undefined,
    sender: {
      uid: message.sender.uid,
      name: message.sender.name,
      avatarUrl: message.sender.avatarUrl,
      gender: message.sender.gender,
      userGroup: message.sender.userGroup,
    },
    isDeleted: message.isDeleted,
    attachments: message.attachments,
    firstAttachmentKind: message.attachments?.[0]?.kind ?? null,
    mentions: message.mentions ?? null,
  };
}

/** Resolve a mention UID to a User object for profile display. */
export function mentionToUser(mentions: MentionInfo[] | undefined, uid: number): User {
  const mention = mentions?.find((m) => m.uid === uid);
  return {
    uid,
    name: mention?.username ?? null,
    avatarUrl: mention?.avatarUrl,
    gender: mention?.gender ?? 0,
    userGroup: mention?.userGroup,
  };
}

export interface ListMessagesResponse {
  messages: MessageResponse[];
  nextCursor: string | null;
  prevCursor?: string | null;
}

export interface SearchMessagesResponse {
  messages: MessageResponse[];
  nextOffset: number | null;
}

export interface SearchMessagesParams {
  q: string;
  limit?: number;
  offset?: number;
}

export function buildSearchMessagesParams(params: SearchMessagesParams): Record<string, string | number> {
  const query: Record<string, string | number> = { q: params.q.trim() };
  if (params.limit != null) query.limit = params.limit;
  if (params.offset != null) query.offset = params.offset;
  return query;
}

export interface CreateMessageBody {
  message?: string;
  messageType: string;
  stickerId?: string;
  clientGeneratedId: string;
  replyToId?: string;
  replyRootId?: string;
  attachmentIds?: string[];
}

export function getMessages(
  chatId: string | number,
  params?: { before?: string; around?: string; after?: string; max?: number; threadId?: string },
): Promise<AxiosResponse<ListMessagesResponse>> {
  const query: Record<string, string | number> = {};
  if (params?.before != null) query.before = params.before;
  if (params?.around != null) query.around = params.around;
  if (params?.after != null) query.after = params.after;
  if (params?.max != null) query.max = params.max;
  if (params?.threadId != null) query.threadId = params.threadId;
  return apiClient.get(`/chats/${chatId}/messages`, { params: query });
}

export function searchMessages(
  chatId: string | number,
  params: SearchMessagesParams,
  options?: { signal?: AbortSignal },
): Promise<AxiosResponse<SearchMessagesResponse>> {
  return apiClient.get(`/chats/${chatId}/messages/search`, {
    params: buildSearchMessagesParams(params),
    signal: options?.signal,
  });
}

export function sendMessage(chatId: string | number, body: CreateMessageBody): Promise<AxiosResponse<MessageResponse>> {
  return apiClient.post(`/chats/${chatId}/messages`, body);
}

export function sendThreadMessage(
  chatId: string | number,
  threadId: string | number,
  body: CreateMessageBody,
): Promise<AxiosResponse<MessageResponse>> {
  return apiClient.post(`/chats/${chatId}/threads/${threadId}/messages`, body);
}

export interface UpdateMessageBody {
  message: string;
  attachmentIds?: string[];
}

export function updateMessage(
  chatId: string | number,
  messageId: string,
  body: UpdateMessageBody,
): Promise<AxiosResponse<MessageResponse>> {
  return apiClient.patch(`/chats/${chatId}/messages/${messageId}`, body);
}

export function deleteMessage(chatId: string | number, messageId: string): Promise<AxiosResponse<void>> {
  return apiClient.delete(`/chats/${chatId}/messages/${messageId}`);
}

export function getMessage(chatId: string | number, messageId: string): Promise<AxiosResponse<MessageResponse>> {
  return apiClient.get(`/chats/${chatId}/messages/${messageId}`);
}

export function putReaction(chatId: string | number, messageId: string, emoji: string): Promise<AxiosResponse<void>> {
  return apiClient.put(`/chats/${chatId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

export function deleteReaction(
  chatId: string | number,
  messageId: string,
  emoji: string,
): Promise<AxiosResponse<void>> {
  return apiClient.delete(`/chats/${chatId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

export function getReactionDetails(
  chatId: string | number,
  messageId: string,
): Promise<AxiosResponse<ReactionDetailResponse>> {
  return apiClient.get(`/chats/${chatId}/messages/${messageId}/reactions`);
}

export function markMessagesAsRead(
  chatId: string | number,
  messageId: string | number,
): Promise<AxiosResponse<MarkChatReadStateResponse>> {
  return apiClient.post(`/chats/${chatId}/read`, { messageId: messageId.toString() });
}

export function markChatAsUnread(chatId: string | number): Promise<AxiosResponse<MarkChatReadStateResponse>> {
  return apiClient.post(`/chats/${chatId}/unread`);
}
