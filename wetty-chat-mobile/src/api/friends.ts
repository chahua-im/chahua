import apiClient from './client';
import type { MemberSummary } from './users';

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'archived';

/**
 * How a user gates incoming friend requests.
 * - `direct`: anyone may request; no verification message allowed (switch off).
 * - `need_message`: requester must attach a non-empty verification message.
 * - `forbid`: all incoming requests are rejected.
 * - `question`: requester must answer a pre-set question (manual review).
 */
export type FriendAddVerificationMode = 'direct' | 'need_message' | 'forbid' | 'question';

export interface FriendResponse {
  user: MemberSummary;
  since: string;
}

export interface ListFriendsResponse {
  friends: FriendResponse[];
}

/** The authenticated user's current relationship with one profile user. */
export interface FriendRelationshipResponse {
  peerUid: number;
  isFriend: boolean;
  dmChatId: string | null;
  blocking: boolean;
  blockedBy: boolean;
  canDm: boolean;
  hasPendingOutgoingRequest: boolean;
}

export interface FriendRequestResponse {
  id: string;
  from: MemberSummary;
  to: MemberSummary;
  status: FriendRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Verification message (need_message) or the requester's answer (question); null for direct. */
  message?: string | null;
  /** Snapshot of the target's question (question mode only); null otherwise. */
  question?: string | null;
}

export type FriendRequestDirection = 'incoming' | 'outgoing';

export interface FriendRequestHistoryEntry extends FriendRequestResponse {
  /** Direction relative to the current user, as decided by the server. */
  direction: FriendRequestDirection;
}

export interface ListFriendRequestHistoryResponse {
  requests: FriendRequestHistoryEntry[];
}

export interface FriendSettingsResponse {
  mode: FriendAddVerificationMode;
  question: string | null;
}

export interface FriendAddInfoResponse {
  mode: FriendAddVerificationMode;
  question: string | null;
}

export interface UpdateFriendSettingsBody {
  mode: FriendAddVerificationMode;
  question: string | null;
}

export const friendsApi = {
  listFriends: async (): Promise<FriendResponse[]> => {
    const res = await apiClient.get<ListFriendsResponse>('/friends');
    return res.data.friends;
  },

  getRelationship: async (uid: number): Promise<FriendRelationshipResponse> => {
    const res = await apiClient.get<FriendRelationshipResponse>(`/friends/${uid}`);
    return res.data;
  },

  removeFriend: async (uid: number): Promise<void> => {
    await apiClient.delete(`/friends/${uid}`);
  },

  /**
   * Send a friend request. `message` is the verification message (need_message)
   * or the answer to the target's question (question); omitted for direct.
   */
  createRequest: async (toUid: number, message?: string): Promise<FriendRequestResponse> => {
    const res = await apiClient.post<FriendRequestResponse>('/friends/requests', { toUid, message });
    return res.data;
  },

  /** Friend-request history in server-defined order, optionally filtered by archive view. */
  listRequestHistory: async (archived?: boolean): Promise<FriendRequestHistoryEntry[]> => {
    const res = await apiClient.get<ListFriendRequestHistoryResponse>('/friends/requests', { params: { archived } });
    return res.data.requests;
  },

  acceptRequest: async (requestId: string): Promise<FriendRequestResponse> => {
    const res = await apiClient.post<FriendRequestResponse>(`/friends/requests/${requestId}/accept`);
    return res.data;
  },

  rejectRequest: async (requestId: string): Promise<FriendRequestResponse> => {
    const res = await apiClient.post<FriendRequestResponse>(`/friends/requests/${requestId}/reject`);
    return res.data;
  },

  archiveRequest: async (requestId: string): Promise<void> => {
    await apiClient.put(`/friends/requests/${requestId}/archive`);
  },

  getMySettings: async (): Promise<FriendSettingsResponse> => {
    const res = await apiClient.get<FriendSettingsResponse>('/friends/me/settings');
    return res.data;
  },

  updateMySettings: async (body: UpdateFriendSettingsBody): Promise<FriendSettingsResponse> => {
    const res = await apiClient.put<FriendSettingsResponse>('/friends/me/settings', body);
    return res.data;
  },

  /** What a requester needs in order to add `uid` as a friend. */
  getAddInfo: async (uid: number): Promise<FriendAddInfoResponse> => {
    const res = await apiClient.get<FriendAddInfoResponse>(`/friends/add-info/${uid}`);
    return res.data;
  },
};
