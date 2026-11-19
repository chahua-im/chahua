import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController, ToastController } from '@ionic/angular';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { RpcApi } from '../../../generated/rpc-api';
import { GroupKind, MessageType, type MessageResponse } from '../../../generated/models';
import { mockRealtime, testChat, testMessage } from '../../api/testing';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { Connection } from '../../api/connection';
import { RpcError, RpcErrorCode, RpcTransportError } from '../../api/rpc-error';
import { ChatStore } from '../../chats/chat-store';
import { SessionStore } from '../../session/session-store';
import { MessageOutbox } from '../message-outbox';
import { ForwardPanel } from './forward-panel';

const target = { chatId: testChat.id, kind: GroupKind.group, name: 'Target', avatar: {}, time: 0 };
function setup() {
  const live = new Subject<MessageResponse>();
  const user = signal<{ uid: number; username?: string }>({ uid: 1 });
  const messages = {
    sendForward: vi.fn().mockReturnValue(of({ message: testMessage })),
    list: vi.fn(),
  };
  const metadata = { isAccessible: () => true, canSpeak: () => true, ensureDetails: async () => {} };
  const enqueue = vi.fn();
  const accept = vi.fn((message: MessageResponse) => live.next(message));
  const toast = { present: vi.fn().mockResolvedValue(undefined) };
  const confirmation = {
    present: async () => {},
    dismiss: () => {},
    onDidDismiss: vi.fn(async () => ({ role: 'confirm' })),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: MessageOutbox, useValue: { enqueue } },
      { provide: RpcApi, useValue: { messages } },
      { provide: Connection, useValue: { ...mockRealtime({ messages$: live }), accept } },
      { provide: SessionStore, useValue: { user } },
      { provide: ChatStore, useValue: metadata },
      { provide: ToastController, useValue: { create: vi.fn().mockResolvedValue(toast) } },
      { provide: AlertController, useValue: { create: async () => confirmation } },
    ],
  });
  TestBed.overrideComponent(ForwardPanel, { set: { template: '' } });
  const fixture = TestBed.createComponent(ForwardPanel);
  fixture.componentRef.setInput('initialTarget', target);
  fixture.componentRef.setInput('sources', [testMessage]);
  fixture.detectChanges();
  return { fixture, panel: fixture.componentInstance, enqueue, messages, accept, toast, user, live, confirmation };
}

describe('ForwardPanel', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a local preview and cancels without a forward RPC', async () => {
    const { fixture, panel, messages, user } = setup();
    await fixture.whenStable();
    const preview = panel['forwardPreview']();
    user.set({ uid: 1, username: 'Updated name' });
    expect(panel['previewMessage']()).toMatchObject({ message: testMessage.message, sender: { name: 'Updated name' } });
    expect(panel['forwardPreview']()).toBe(preview);
    expect(messages.list).not.toHaveBeenCalled();
    panel['close']();
    fixture.destroy();
    expect(messages.sendForward).not.toHaveBeenCalled();
  });

  it('submits once, waits for confirmation and closes without sending a blank comment', async () => {
    const { fixture, panel, messages, accept, toast, enqueue } = setup();
    await fixture.whenStable();
    panel['comment'].set('    ');
    const response = new Subject<{ message: MessageResponse }>();
    messages.sendForward.mockReturnValue(response);
    const pending = panel['send']();
    await panel['send']();
    panel['close']();
    expect(panel.open()).toBe(true);
    expect(messages.sendForward).toHaveBeenCalledOnce();
    response.next({ message: testMessage });
    await pending;
    expect(messages.sendForward).toHaveBeenCalledWith({
      clientGeneratedId: expect.any(String),
      sourceChatId: testMessage.chatId,
      messageIds: [testMessage.id],
      confirmedPlaceholders: undefined,
      chatId: target.chatId,
      threadId: undefined,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledWith(testMessage);
    expect(panel['open']()).toBe(false);
    expect(toast.present).toHaveBeenCalledOnce();
  });

  it('drops the unsent comment when an uncertain forward is closed', async () => {
    const { fixture, panel, messages, live, enqueue } = setup();
    await fixture.whenStable();
    panel['comment'].set('comment');
    messages.sendForward.mockReturnValueOnce(throwError(() => new RpcTransportError('timeout')));
    await panel['send']();
    const { clientGeneratedId } = messages.sendForward.mock.calls[0][0];
    panel['close']();
    live.next({ ...testMessage, clientGeneratedId, chatId: target.chatId, sender: { ...testMessage.sender, uid: 1 } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores the RPC and echo for an operation from a previous session', async () => {
    const { fixture, panel, user, messages, live, enqueue, accept } = setup();
    await fixture.whenStable();
    const reply = new Subject<{ message: MessageResponse }>();
    messages.sendForward.mockReturnValueOnce(reply);
    panel['comment'].set('old account');
    const attempt = panel['send']();
    const { clientGeneratedId } = messages.sendForward.mock.calls[0][0];
    const message = { ...testMessage, clientGeneratedId };
    user.set({ uid: 2 });
    live.next(message);
    TestBed.tick();
    expect(panel.open()).toBe(false);
    user.set({ uid: 1 });
    reply.next({ message });
    await attempt;
    expect(accept).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('retries an uncertain forward with the original operation and comment', async () => {
    const { fixture, panel, messages, enqueue } = setup();
    await fixture.whenStable();
    panel['comment'].set('first');
    messages.sendForward.mockReturnValueOnce(throwError(() => new RpcTransportError('timeout')));
    await panel['send']();
    const original = messages.sendForward.mock.calls[0][0];
    expect(enqueue).not.toHaveBeenCalled();
    expect(await panel.choose({ ...target, chatId: encodeId('555') }, () => true)).toBe(false);
    panel['comment'].set('changed');
    messages.sendForward.mockReturnValueOnce(of({ messageId: testMessage.id }));
    await panel['send']();
    expect(messages.sendForward.mock.calls).toEqual([[original], [original]]);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(target.chatId, undefined, 'first', {
      messageType: MessageType.text,
      attachmentIds: [],
      markRead: false,
    });
  });

  it('confirms only the newly reported replacements before resubmitting the full selection', async () => {
    const { fixture, panel, messages, confirmation } = setup();
    const audio = { ...testMessage, messageType: MessageType.audio };
    const card = {
      ...testMessage,
      id: encodeId('9007199254741004'),
      messageType: MessageType.forwarded,
      forwardedPreview: { total: 1, messages: [], containsForwardedMessages: true },
    };
    const ready = { ...audio, id: encodeId('9007199254741005') };
    fixture.componentRef.setInput('sources', [ready, card, audio]);
    const known = { [decodeId(card.id)]: 'nestedForward' };
    const both = { ...known, [decodeId(audio.id)]: 'pendingAudio' };
    await vi.waitFor(() => expect(panel['confirmedPlaceholders']()).toEqual(known));
    expect(panel['forwardPreview']()?.records?.[0].messageType).toBe(MessageType.audio);
    const dismiss = new Subject<{ role: string }>();
    confirmation.onDidDismiss.mockReturnValueOnce(firstValueFrom(dismiss));
    messages.sendForward.mockReturnValueOnce(
      throwError(() => new RpcError(RpcErrorCode.BadRequest, 'consent required', { forwardPlaceholdersById: both })),
    );
    await panel['send']();
    expect(messages.sendForward.mock.calls[0][0].confirmedPlaceholders).toEqual(known);
    await vi.waitFor(() => expect(confirmation.onDidDismiss).toHaveBeenCalledTimes(2));
    expect(panel['placeholderPending']()).toBe('confirmPendingAudio');
    await panel['send']();
    expect(messages.sendForward).toHaveBeenCalledOnce();
    dismiss.next({ role: 'confirm' });
    await vi.waitFor(() => expect(panel['confirmedPlaceholders']()).toEqual(both));
    expect(panel['forwardPreview']()?.records).toMatchObject([
      { id: audio.id, messageType: MessageType.placeholder, message: 'pendingAudio' },
      { id: card.id, messageType: MessageType.placeholder, message: 'nestedForward' },
      { id: ready.id, messageType: MessageType.audio },
    ]);
    await panel['send']();
    expect(messages.sendForward.mock.calls[1][0].confirmedPlaceholders).toEqual(both);
  });
});
