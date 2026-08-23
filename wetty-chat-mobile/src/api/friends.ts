import apiClient from './client';
import type { MemberSummary } from './users';

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected';

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

export interface ListFriendRequestsResponse {
  requests: FriendRequestResponse[];
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

  listIncomingRequests: async (): Promise<FriendRequestResponse[]> => {
    const res = await apiClient.get<ListFriendRequestsResponse>('/friends/requests/incoming');
    return res.data.requests;
  },

  listOutgoingRequests: async (): Promise<FriendRequestResponse[]> => {
    const res = await apiClient.get<ListFriendRequestsResponse>('/friends/requests/outgoing');
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
