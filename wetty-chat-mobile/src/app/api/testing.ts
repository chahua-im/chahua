import { merge, Subject, filter, map } from 'rxjs';
import { isMessageChange, type MessageChange, type PinChange } from '../messages/message-change';
import { ServerWsMessageType, type ServerWsMessage } from '../../generated/models';
import { GroupKind, MessageType } from '../../generated/models';
import type { ChatListItem, MeResponse, MessageResponse } from '../../generated/models';
import { decodeId, encodeId } from './snowflake-id';

export const testUser: MeResponse = { uid: 1, username: '测试用户', gender: 0, permissions: [], stickerPackOrder: [] };
export const testChat: ChatListItem = {
  id: encodeId('9007199254740993'),
  kind: GroupKind.group,
  name: '测试群',
  archived: false,
  unreadCount: 2,
};
export const testMessage: MessageResponse = {
  id: encodeId('9007199254741003'),
  chatId: testChat.id,
  clientGeneratedId: 'test-message',
  createdAt: '2026-09-05T12:00:00Z',
  sender: { uid: 1, name: '测试用户', gender: 0 },
  message: '测试消息',
  messageType: MessageType.text,
  isDeleted: false,
  isEdited: false,
  hasAttachments: false,
  attachments: [],
  reactions: [],
};

/** Server fixtures use decimal strings; application fixtures above use encoded IDs. */
export const wireChat = { ...testChat, id: decodeId(testChat.id) };
export const wireMessage = {
  ...testMessage,
  id: decodeId(testMessage.id),
  chatId: decodeId(testMessage.chatId),
};

export function mockRealtime({
  messages$ = new Subject<MessageResponse>(),
  events$ = new Subject<ServerWsMessage>(),
  resync$ = new Subject<void>(),
} = {}) {
  return {
    events$: merge(
      events$,
      messages$.pipe(map((payload): ServerWsMessage => ({ type: ServerWsMessageType.message, payload }))),
    ),
    resync$,
    messages$: merge(
      messages$,
      events$.pipe(
        filter((event) => event.type === ServerWsMessageType.message),
        map((event) => event.payload),
      ),
    ),
    changes$: events$.pipe(filter(isMessageChange)),
    accept: (message: MessageResponse) => events$.next({ type: ServerWsMessageType.message, payload: message }),
    acceptPin: (event: PinChange) => events$.next(event),
    acceptChange: (event: MessageChange) => events$.next(event),
  };
}
