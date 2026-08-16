import { describe, expect, it } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import type { PinResponse } from '@/api/pins';
import type { RootState } from './index';
import { messagePatched } from './messageEvents';
import reducer, {
  addPin,
  pinScopeKey,
  removePin,
  selectPinsForScope,
  setPins,
  type PinsState,
} from './pinsSlice';

function message(id: string, createdAt: string): MessageResponse {
  return {
    id,
    message: `body ${id}`,
    messageType: 'text',
    replyRootId: null,
    clientGeneratedId: `client-${id}`,
    sender: { uid: 1, name: 'Alice', gender: 0 },
    chatId: 'c1',
    createdAt,
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
  };
}

function pin(id: string, msg: MessageResponse, threadRootId?: string): PinResponse {
  return {
    id,
    chatId: 'c1',
    threadRootId,
    message: msg,
    pinnedBy: 1,
    pinnedAt: '2026-08-15T00:00:00Z',
    expiresAt: null,
  };
}

/** Selectors take RootState but only read the pins slice. */
function asRootState(pins: PinsState): RootState {
  return { pins } as RootState;
}

const chatMessage = message('m1', '2026-08-15T10:00:00Z');
const threadReply = message('m2', '2026-08-15T11:00:00Z');
const chatPin = pin('p1', chatMessage);
const threadPin = pin('p2', threadReply, 't9');

describe('pinsSlice scopes', () => {
  it('builds distinct scope keys for chat and thread pins', () => {
    expect(pinScopeKey('c1')).toBe('c1');
    expect(pinScopeKey('c1', undefined)).toBe('c1');
    expect(pinScopeKey('c1', 't9')).toBe('c1_thread_t9');
  });

  it('keeps chat pins and thread pins in independent lists', () => {
    let state = reducer(undefined, setPins({ chatId: 'c1', pins: [chatPin] }));
    state = reducer(state, setPins({ chatId: 'c1', threadRootId: 't9', pins: [threadPin] }));

    expect(selectPinsForScope(asRootState(state), 'c1')).toEqual([chatPin]);
    expect(selectPinsForScope(asRootState(state), 'c1_thread_t9')).toEqual([threadPin]);
  });

  it('routes addPin and removePin by the pin thread scope', () => {
    let state = reducer(undefined, setPins({ chatId: 'c1', pins: [] }));
    state = reducer(state, addPin(threadPin));

    expect(selectPinsForScope(asRootState(state), 'c1')).toEqual([]);
    expect(selectPinsForScope(asRootState(state), 'c1_thread_t9')).toEqual([threadPin]);

    state = reducer(state, removePin({ chatId: 'c1', pinId: 'p2' }));
    // Removing from the chat scope must not touch the thread scope.
    expect(selectPinsForScope(asRootState(state), 'c1_thread_t9')).toEqual([threadPin]);

    state = reducer(state, removePin({ chatId: 'c1', threadRootId: 't9', pinId: 'p2' }));
    expect(selectPinsForScope(asRootState(state), 'c1_thread_t9')).toEqual([]);
  });

  it('patches a message pinned in both the chat and a thread', () => {
    const sharedPinnedChatWide = pin('p1', chatMessage);
    const sharedPinnedInThread = pin('p3', chatMessage, 't9');

    let state = reducer(undefined, setPins({ chatId: 'c1', pins: [sharedPinnedChatWide] }));
    state = reducer(state, setPins({ chatId: 'c1', threadRootId: 't9', pins: [sharedPinnedInThread] }));

    state = reducer(
      state,
      messagePatched({
        chatId: 'c1',
        messageId: 'm1',
        message: { ...chatMessage, isDeleted: true },
      }),
    );

    expect(selectPinsForScope(asRootState(state), 'c1')[0].message).toMatchObject({
      isDeleted: true,
      message: null,
    });
    expect(selectPinsForScope(asRootState(state), 'c1_thread_t9')[0].message).toMatchObject({
      isDeleted: true,
      message: null,
    });
  });
});
