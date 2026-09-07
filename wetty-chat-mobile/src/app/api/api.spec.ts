import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { expectTypeOf } from 'vitest';

import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { getMessagesResource } from '../../generated/endpoints/chats/chats.resource';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { GroupsService } from '../../generated/endpoints/groups/groups.service';
import { InvitesService } from '../../generated/endpoints/invites/invites.service';
import type {
  ListThreadsResponse,
  MessageResponse,
  ServiceTokenResponse,
  ThreadListItem,
  UserGroupTagInfo,
} from '../../generated/models';
import { decodeJsonIds, encodeJsonIds } from './json-ids';
import { jsonInterceptor } from './json.interceptor';
import { encodeId, type SnowflakeID } from './snowflake-id';
import { testChat, testMessage, wireChat, wireMessage } from './testing';

describe('Generated API client', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
      ],
    });
  });

  it('preserves snowflake IDs beyond the safe integer range in paths and cursors', () => {
    const mockChatId = ((1n << 63n) - 1n).toString();
    const mockCursor = (BigInt(Number.MAX_SAFE_INTEGER) + 2n).toString();

    TestBed.inject(ChatsService)
      .getMessages(encodeId(mockChatId), { before: encodeId(mockCursor) })
      .subscribe();

    const http = TestBed.inject(HttpTestingController);
    const request = http.expectOne(`/_api/chats/${mockChatId}/messages?before=${mockCursor}`);
    expect(request.request.method).toBe('GET');
    request.flush({ messages: [], nextCursor: null, prevCursor: null, olderCursor: null, newerCursor: null });
    http.verify();
  });

  it('preserves null in nested response fields and preserves explicit cache clears for both clients', async () => {
    const body = () => ({
      messages: [{ ...wireMessage, message: null, sticker: null, replyToMessage: null }],
      olderCursor: null,
      newerCursor: null,
    });
    const http = TestBed.inject(HttpTestingController);
    const receive = vi.fn();
    TestBed.inject(ChatsService).getMessages(testChat.id).subscribe(receive);
    http.expectOne(`/_api/chats/${wireChat.id}/messages`).flush(body());
    const value = receive.mock.calls[0][0];
    expect(value.olderCursor).toBeNull();
    expect(Object.hasOwn(value, 'olderCursor')).toBe(true);
    expect(value.messages[0].sticker).toBeNull();
    expect(Object.hasOwn(value.messages[0], 'sticker')).toBe(true);
    expect(value.messages[0].id).toBe(testMessage.id);
    expect(value.messages[0].chatId).toBe(testChat.id);

    const resource = TestBed.runInInjectionContext(() => getMessagesResource(signal(testChat.id)));
    TestBed.tick();
    http.expectOne(`/_api/chats/${wireChat.id}/messages`).flush(body());
    await TestBed.inject(ApplicationRef).whenStable();
    TestBed.tick();
    expect(resource.value()).toEqual(value);
    http.verify();
  });

  it('keeps wire clearing requests, third-party responses, and empty HTTP bodies intact', () => {
    const http = TestBed.inject(HttpTestingController);
    const client = TestBed.inject(HttpClient);
    const empty = vi.fn();
    TestBed.inject(GroupsService).patchGroup(testChat.id, { avatarImageId: null }).subscribe(empty);
    const patch = http.expectOne(`/_api/group/${wireChat.id}`);
    expect(patch.request.body).toEqual({ avatarImageId: null });
    patch.flush(null, { status: 204, statusText: 'No Content' });
    expect(empty).toHaveBeenCalledWith(null);

    const external = vi.fn();
    client.get('https://example.com/data').subscribe(external);
    http.expectOne('https://example.com/data').flush({ value: null });
    expect(external).toHaveBeenCalledWith({ value: null });

    TestBed.inject(InvitesService).patchInvite(testMessage.id, { expiresAt: null }).subscribe();
    const invite = http.expectOne(`/_api/invites/invite/${wireMessage.id}`);
    expect(invite.request.body).toEqual({ expiresAt: null });
    invite.flush(null, { status: 204, statusText: 'No Content' });
    http.verify();
  });

  it('restores nested request IDs and arrays without changing application objects', () => {
    const body = {
      messageType: testMessage.messageType,
      message: '9007199254740993',
      clientGeneratedId: '9223372036854775807',
      replyToId: testMessage.id,
      attachmentIds: [encodeId('9223372036854775807')],
    };
    TestBed.inject(ChatsService).postMessage(testChat.id, body).subscribe();
    const http = TestBed.inject(HttpTestingController);
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(request.request.body).toEqual({
      ...body,
      replyToId: wireMessage.id,
      attachmentIds: ['9223372036854775807'],
    });
    expect(body.replyToId).toBe(testMessage.id);
    expect(body.attachmentIds).toEqual([encodeId('9223372036854775807')]);
    request.flush({ ...wireMessage });
    http.verify();
  });

  it('converts nested DTO IDs while preserving ordinary numbers, numeric text, and timestamp cursors', () => {
    const message = {
      ...wireMessage,
      clientGeneratedId: '9223372036854775807',
      sender: { uid: 7, userGroup: { groupId: 3, name: null } },
      sticker: { id: '9223372036854775807', media: { id: '9007199254740993' } },
    };
    const encoded = encodeJsonIds(message, 'MessageResponse') as MessageResponse;
    expect(encoded.id).toBe(testMessage.id);
    expect(encoded.sticker?.id).toBe(encodeId('9223372036854775807'));
    expect(encoded.sticker?.media.id).toBe(testChat.id);
    expect(encoded.sender.uid).toBe(7);
    expect(encoded.sender.userGroup?.groupId).toBe(3);
    expect(encoded.sender.userGroup?.name).toBeNull();
    expect(encoded.clientGeneratedId).toBe('9223372036854775807');
    expect(encodeJsonIds(encoded, 'MessageResponse')).toEqual(encoded);
    expect((decodeJsonIds(encoded, 'MessageResponse') as { id: string }).id).toBe(wireMessage.id);
    expect(encodeJsonIds({ nextCursor: '2026-09-06T12:00:00Z', threads: [] }, 'ListThreadsResponse')).toEqual({
      nextCursor: '2026-09-06T12:00:00Z',
      threads: [],
    });
    expect(encodeJsonIds({ id: 42 }, 'ServiceTokenResponse')).toEqual({ id: 42 });
  });

  it('keeps encoded IDs distinct in generated DTOs, service arguments, and resource signals', () => {
    expectTypeOf<MessageResponse['id']>().toEqualTypeOf<SnowflakeID>();
    expectTypeOf<ThreadListItem['chatId']>().toEqualTypeOf<SnowflakeID>();
    expectTypeOf<Parameters<ChatsService['getMessages']>[0]>().toEqualTypeOf<SnowflakeID>();
    expectTypeOf<Parameters<typeof getMessagesResource>[0]>().toEqualTypeOf<Signal<SnowflakeID>>();
    expectTypeOf<ServiceTokenResponse['id']>().toEqualTypeOf<number>();
    expectTypeOf<UserGroupTagInfo['groupId']>().toEqualTypeOf<number>();
    expectTypeOf<ListThreadsResponse['nextCursor']>().toEqualTypeOf<string | undefined>();
  });

  it('preserves array positions, false, zero, and empty strings and is safe to encode twice', () => {
    const value = { entries: [null, { value: null }], enabled: false, count: 0, text: '' };
    encodeJsonIds(value);
    expect(value).toEqual({ entries: [null, { value: null }], enabled: false, count: 0, text: '' });
    expect(Object.hasOwn(value.entries, 0)).toBe(true);
    expect(encodeJsonIds(value)).toEqual(value);
  });
});
