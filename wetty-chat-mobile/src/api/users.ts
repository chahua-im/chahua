import apiClient from './client';
import type { UserGroupTagInfo } from './messages';

export interface StickerPackOrderItem {
  stickerPackId: string;
  lastUsedOn: number;
}

export interface UpdateStickerPackOrderItem {
  stickerPackId: string;
  lastUsedOn: number;
  isAutoSort?: boolean;
}

export interface User {
  uid: number;
  username: string;
  avatarUrl?: string | null;
  gender: number;
  userGroup?: UserGroupTagInfo | null;
  stickerPackOrder?: StickerPackOrderItem[];
  permissions?: string[];
}

export interface MemberSummary {
  uid: number;
  username: string | null;
  avatarUrl?: string | null;
  gender: number;
  userGroup?: UserGroupTagInfo | null;
}

export interface SearchMembersResponse {
  members: MemberSummary[];
  excluded: MemberSummary[];
}

export const usersApi = {
  getCurrentUser: async (): Promise<User> => {
    const response = await apiClient.get<User>('/users/me');
    return response.data;
  },

  searchMembers: async (params: {
    q?: string;
    limit?: number;
    excludeMemberOf?: string | number;
  }): Promise<SearchMembersResponse> => {
    const response = await apiClient.get<SearchMembersResponse>('/users/search', { params });
    return response.data;
  },

  updateStickerPackOrder: async (order: UpdateStickerPackOrderItem[]): Promise<void> => {
    await apiClient.put('/users/me/stickerpack-order', { order });
  },
};
