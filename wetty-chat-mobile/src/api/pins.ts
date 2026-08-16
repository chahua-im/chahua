import type { AxiosResponse } from 'axios';
import type { MessageResponse } from './messages';
import apiClient from './client';

export interface PinResponse {
  id: string;
  chatId: string;
  /** Absent for chat-level pins; set for pins scoped to a thread. */
  threadRootId?: string | null;
  message: MessageResponse;
  pinnedBy: number;
  pinnedAt: string;
  expiresAt: string | null;
}

export interface ListPinsResponse {
  pins: PinResponse[];
}

export function listPins(chatId: string): Promise<AxiosResponse<ListPinsResponse>> {
  return apiClient.get(`/chats/${chatId}/pins`);
}

export function createPin(chatId: string, messageId: string): Promise<AxiosResponse<PinResponse>> {
  return apiClient.post(`/chats/${chatId}/pins`, { messageId });
}

export function deletePin(chatId: string, pinId: string): Promise<AxiosResponse<void>> {
  return apiClient.delete(`/chats/${chatId}/pins/${pinId}`);
}

export function listThreadPins(
  chatId: string,
  threadRootId: string,
): Promise<AxiosResponse<ListPinsResponse>> {
  return apiClient.get(`/chats/${chatId}/threads/${threadRootId}/pins`);
}

export function createThreadPin(
  chatId: string,
  threadRootId: string,
  messageId: string,
): Promise<AxiosResponse<PinResponse>> {
  return apiClient.post(`/chats/${chatId}/threads/${threadRootId}/pins`, { messageId });
}

export function deleteThreadPin(
  chatId: string,
  threadRootId: string,
  pinId: string,
): Promise<AxiosResponse<void>> {
  return apiClient.delete(`/chats/${chatId}/threads/${threadRootId}/pins/${pinId}`);
}
