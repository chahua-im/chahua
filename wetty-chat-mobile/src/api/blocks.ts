import apiClient from './client';
import type { MemberSummary } from './users';

export interface BlockResponse {
  user: MemberSummary;
  since: string;
}

export interface ListBlocksResponse {
  blocks: BlockResponse[];
}

export const blocksApi = {
  listBlocks: async (): Promise<BlockResponse[]> => {
    const res = await apiClient.get<ListBlocksResponse>('/blocks');
    return res.data.blocks;
  },

  blockUser: async (uid: number): Promise<void> => {
    await apiClient.post('/blocks', { uid });
  },

  unblockUser: async (uid: number): Promise<void> => {
    await apiClient.delete(`/blocks/${uid}`);
  },
};
