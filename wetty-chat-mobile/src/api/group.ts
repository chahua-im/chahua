import type { AxiosResponse } from 'axios';
import apiClient from './client';
import type { UserGroupTagInfo } from './messages';
import type { MemberSummary } from './users';
import type { GroupKind } from './chats';

export interface GroupInfoResponse {
  id: string;
  name: string;
  description: string | null;
  avatarImageId: string | null;
  avatar: string | null;
  visibility: string;
  createdAt: string;
  mutedUntil?: string | null;
  myRole: GroupRole | null;
  /** Discriminator added when DMs are enabled; absent on older payloads means a group chat. */
  kind?: GroupKind;
  /** For DM chats, the other participant. Null/absent for group chats. */
  peer?: MemberSummary | null;
}

export interface UpdateGroupInfoBody {
  name?: string;
  description?: string;
  avatarImageId?: string | null;
  visibility?: string;
}

export interface GroupAvatarUploadUrlRequest {
  filename: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
}

export interface GroupAvatarUploadUrlResponse {
  imageId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
}

export interface MemberResponse {
  uid: number;
  role: string;
  joinedAt: string;
  username: string | null;
  avatarUrl: string | null;
  gender: number;
  userGroup?: UserGroupTagInfo | null;
}

export interface ListMembersResponse {
  members: MemberResponse[];
  nextCursor: number | null;
  canManageMembers: boolean;
}

export type GroupSearchMode = 'autocomplete' | 'submitted';
export type GroupSelectorScope = 'manageable' | 'joined' | 'public';
export type GroupRole = 'member' | 'admin';
export type GroupVisibility = 'public' | 'semi_public' | 'private';

export interface GroupSelectorItem {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  visibility: GroupVisibility;
  role?: GroupRole | null;
}

export interface ListGroupsResponse {
  groups: GroupSelectorItem[];
  nextCursor: string | null;
}

export type MemberSearchMode = 'autocomplete' | 'submitted';

export interface AddMemberBody {
  uid: number;
  role?: string;
}

export interface UpdateMemberRoleBody {
  role: string;
}

export interface MuteChatBody {
  durationSeconds?: number | null;
}

export function getGroupInfo(chatId: string | number): Promise<AxiosResponse<GroupInfoResponse>> {
  return apiClient.get(`/group/${chatId}`);
}

export function listGroups(
  params: {
    q?: string;
    mode?: GroupSearchMode;
    scope?: GroupSelectorScope;
    limit?: number;
    after?: string;
  } = {},
): Promise<AxiosResponse<ListGroupsResponse>> {
  return apiClient.get('/group', { params });
}

export function updateGroupInfo(
  chatId: string | number,
  body: UpdateGroupInfoBody,
): Promise<AxiosResponse<GroupInfoResponse>> {
  return apiClient.patch(`/group/${chatId}`, body);
}

export function requestGroupAvatarUploadUrl(
  chatId: string | number,
  body: GroupAvatarUploadUrlRequest,
): Promise<AxiosResponse<GroupAvatarUploadUrlResponse>> {
  return apiClient.post(`/group/${chatId}/avatar/upload-url`, body);
}

export function getMembers(
  chatId: string | number,
  params: { q?: string; mode?: MemberSearchMode; limit?: number; after?: number } = {},
): Promise<AxiosResponse<ListMembersResponse>> {
  return apiClient.get(`/group/${chatId}/members`, { params });
}

export function addMember(chatId: string | number, body: AddMemberBody): Promise<AxiosResponse<MemberResponse>> {
  return apiClient.post(`/group/${chatId}/members`, body);
}

export function removeMember(
  chatId: string | number,
  uid: number,
  deleteMessages?: string,
): Promise<AxiosResponse<void>> {
  return apiClient.delete(`/group/${chatId}/members/${uid}`, {
    params: deleteMessages ? { deleteMessages } : undefined,
  });
}

export function leaveGroup(chatId: string | number, uid: number): Promise<AxiosResponse<void>> {
  return apiClient.delete(`/group/${chatId}/members/${uid}`);
}

export function updateMemberRole(
  chatId: string | number,
  uid: number,
  body: UpdateMemberRoleBody,
): Promise<AxiosResponse<MemberResponse>> {
  return apiClient.patch(`/group/${chatId}/members/${uid}`, body);
}

export function muteChat(
  chatId: string | number,
  body: MuteChatBody = {},
): Promise<AxiosResponse<{ mutedUntil: string }>> {
  return apiClient.put(`/group/${chatId}/mute`, body);
}

export function unmuteChat(chatId: string | number): Promise<AxiosResponse<void>> {
  return apiClient.delete(`/group/${chatId}/mute`);
}
