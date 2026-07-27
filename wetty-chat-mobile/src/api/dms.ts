import apiClient from './client';
import type { MemberSummary } from './users';

export type GroupKind = 'group' | 'dm';

export interface DmResponse {
  id: string;
  peer: MemberSummary;
}

export const dmsApi = {
  createDm: async (peerUid: number): Promise<DmResponse> => {
    const res = await apiClient.post<DmResponse>('/dms', { peerUid });
    return res.data;
  },
};
