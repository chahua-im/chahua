import apiClient from './client';
import type { MemberSummary } from './users';

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

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
}

export interface ListFriendRequestsResponse {
  requests: FriendRequestResponse[];
}

export const friendsApi = {
  listFriends: async (): Promise<FriendResponse[]> => {
    const res = await apiClient.get<ListFriendsResponse>('/friends');
    return res.data.friends;
  },

  removeFriend: async (uid: number): Promise<void> => {
    await apiClient.delete(`/friends/${uid}`);
  },

  createRequest: async (toUid: number): Promise<FriendRequestResponse> => {
    const res = await apiClient.post<FriendRequestResponse>('/friends/requests', { toUid });
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
    const res = await apiClient.post<FriendRequestResponse>(
      `/friends/requests/${requestId}/accept`,
    );
    return res.data;
  },

  rejectRequest: async (requestId: string): Promise<FriendRequestResponse> => {
    const res = await apiClient.post<FriendRequestResponse>(
      `/friends/requests/${requestId}/reject`,
    );
    return res.data;
  },

  cancelRequest: async (requestId: string): Promise<void> => {
    await apiClient.post(`/friends/requests/${requestId}/cancel`);
  },
};
