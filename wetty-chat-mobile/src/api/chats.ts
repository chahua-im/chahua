import type { AxiosResponse } from 'axios';
import apiClient from './client';
import type { MessagePreview } from './messages';
import type { MemberSummary } from './users';

export type GroupKind = 'group' | 'dm';

export interface ChatListEntry {
  id: string;
  name: string | null;
  avatar: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  unreadMentions: number;
  /** Absent on payloads from backends that predate reaction badges; treat as 0. */
  unreadReactions?: number;
  lastReadMessageId?: string | null;
  lastMessage: MessagePreview | null;
  mutedUntil: string | null;
  archived: boolean;
  /** Discriminator added when DMs are enabled; absent on older payloads means a group chat. */
  kind?: GroupKind;
  /** For DM chats, the other participant. Null/absent for group chats. */
  peer?: MemberSummary | null;
}

export interface ListChatsResponse {
  chats: ChatListEntry[];
  nextCursor: string | null;
}

interface CreateChatResponse {
  id: string;
  name: string | null;
  createdAt: string;
}

export interface ChatUnreadCountResponse {
  lastReadMessageId: string | null;
  unreadCount: number;
  unreadMentions: number;
  /** Absent on older payloads; treat as 0. */
  unreadReactions?: number;
}

export function getChats(
  params: {
    limit?: number;
    after?: string;
    archived?: boolean;
  } = {},
): Promise<AxiosResponse<ListChatsResponse>> {
  return apiClient.get('/chats', { params });
}

export function createChat(body: { name?: string } = {}): Promise<AxiosResponse<CreateChatResponse>> {
  return apiClient.post('/group', body);
}

export function getUnreadCount(): Promise<
  AxiosResponse<{ unreadCount: number; archivedUnreadCount: number; unreadMentions: number }>
> {
  return apiClient.get('/chats/unread');
}

export function getChatUnreadCount(chatId: string | number): Promise<AxiosResponse<ChatUnreadCountResponse>> {
  return apiClient.get(`/chats/${chatId}/unread`);
}

export interface UnreadMentionIdsResponse {
  messageIds: string[];
}

export function getUnreadMentionIds(
  chatId: string | number,
  // Matches the backend `MAX_UNREAD_COUNT` hard cap so the jump window covers the
  // full (capped) unread-mention set.
  { threadId, max = 1000 }: { threadId?: string | number; max?: number } = {},
): Promise<AxiosResponse<UnreadMentionIdsResponse>> {
  return apiClient.get(`/chats/${chatId}/mentions`, { params: { threadId, max } });
}

export interface UnreadReactionIdsResponse {
  messageIds: string[];
}

export function getUnreadReactionIds(
  chatId: string | number,
  // Matches the backend `MAX_UNREAD_COUNT` hard cap so the jump window covers the
  // full (capped) unread-reaction set.
  { threadId, max = 1000 }: { threadId?: string | number; max?: number } = {},
): Promise<AxiosResponse<UnreadReactionIdsResponse>> {
  return apiClient.get(`/chats/${chatId}/reactions`, { params: { threadId, max } });
}

export function archiveChat(chatId: string | number): Promise<AxiosResponse<void>> {
  return apiClient.put(`/chats/${chatId}/archive`);
}

export function unarchiveChat(chatId: string | number): Promise<AxiosResponse<void>> {
  return apiClient.delete(`/chats/${chatId}/archive`);
}
