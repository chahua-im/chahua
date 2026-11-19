import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { RpcApi } from '../../../generated/rpc-api';
import { GroupKind, type MessageResponse } from '../../../generated/models';
import { testMessage } from '../../api/testing';
import { encodeId } from '../../api/snowflake-id';
import { ChatStore } from '../../chats/chat-store';
import { SessionStore } from '../../session/session-store';
import { buildForwardPreview, type ForwardPreview } from './forward-preview';
import { ForwardDetails } from './forward-details';

const bundleId = encodeId('555');
const target = { chatId: testMessage.chatId, kind: GroupKind.group, avatar: {}, time: 0 };
const records = { total: 0, messages: [] };

function setup(preview?: ForwardPreview) {
  const recent = new Subject<{ messages: MessageResponse[] }>();
  const accessible = signal(true);
  const messages = {
    list: vi.fn().mockReturnValue(recent),
    listForwardedMessages: vi.fn().mockReturnValue(of(records)),
    listForwardedBundleMessages: vi.fn().mockReturnValue(of(records)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: RpcApi, useValue: { messages } },
      { provide: ChatStore, useValue: { isAccessible: accessible } },
      { provide: SessionStore, useValue: { user: () => testMessage.sender } },
    ],
  });
  TestBed.overrideComponent(ForwardDetails, { set: { template: '' } });
  const fixture = TestBed.createComponent(ForwardDetails);
  fixture.componentRef.setInput('target', target);
  if (preview) fixture.componentRef.setInput('forwardPreview', preview);
  fixture.detectChanges();
  return { fixture, details: fixture.componentInstance, messages, accessible, recent };
}

describe('ForwardDetails', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('clears recent messages when access is lost and ignores an in-flight response', async () => {
    const { fixture, details, messages, accessible, recent } = setup();
    expect(details['loading']()).toBe(true);
    expect(messages.list).toHaveBeenCalledExactlyOnceWith({ chatId: target.chatId, threadId: undefined, max: 20 });
    accessible.set(false);
    fixture.detectChanges();
    expect(recent.observed).toBe(false);
    recent.next({ messages: [testMessage] });
    await fixture.whenStable();
    expect(details['frames']()).toEqual([]);
    expect(details['unavailable']()).toBe(true);
  });
  it('opens the local merged root without fetching, then reads the chosen source card', async () => {
    const card = { ...testMessage, forwardedBundleId: bundleId, id: encodeId('777') };
    const preview = buildForwardPreview([testMessage, card]);
    const { fixture, messages, details } = setup(preview);
    await fixture.whenStable();
    expect(details['frames']()[0].messages).toEqual(preview.records);
    expect(messages.listForwardedMessages).not.toHaveBeenCalled();
    expect(messages.listForwardedBundleMessages).not.toHaveBeenCalled();
    await details['child'](card);
    await fixture.whenStable();
    expect(messages.listForwardedMessages).toHaveBeenCalledExactlyOnceWith({ chatId: card.chatId, messageId: card.id });
    await details['child']({ ...testMessage, forwardedBundleId: bundleId });
    await fixture.whenStable();
    expect(messages.listForwardedBundleMessages).toHaveBeenLastCalledWith({
      chatId: testMessage.chatId,
      messageId: card.id,
      bundleId,
    });
    expect(details['frames']()).toHaveLength(3);
    details['back']();
    expect(details['frames']()).toHaveLength(2);
    expect(details['canDismiss'](undefined, 'back')).toBe(false);
    expect(details['frames']()).toHaveLength(1);
    expect(messages.listForwardedMessages).toHaveBeenCalledOnce();
    expect(details['canDismiss'](undefined, 'back')).toBe(true);
  });
});
