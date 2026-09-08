import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { MessageResponse } from '../../../generated/models';
import { testChat, testMessage } from '../../api/testing';
import { ChatStore } from '../../chats/chat-store';
import { PushNotifications } from '../push-notifications';
import { NotificationBanner } from './notification-banner';

describe('NotificationBanner', () => {
  const banner = signal<MessageResponse | undefined>(undefined);
  const notifications = { start: vi.fn(), banner, dismiss: vi.fn(() => banner.set(undefined)), open: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    banner.set(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: PushNotifications, useValue: notifications },
        { provide: ChatStore, useValue: { get: () => testChat } },
      ],
    });
  });

  it('shows the current message only while the single-column presentation is enabled', async () => {
    const fixture = TestBed.createComponent(NotificationBanner);
    fixture.componentRef.setInput('enabled', true);
    banner.set(testMessage);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.notification')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain(testChat.name);
    fixture.componentRef.setInput('enabled', false);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.notification')).toBeNull();
    expect(banner()).toBeUndefined();
    fixture.componentRef.setInput('enabled', true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.notification')).toBeNull();
  });

  it('discards wide-layout banners without stopping notification delivery', async () => {
    const fixture = TestBed.createComponent(NotificationBanner);
    fixture.componentRef.setInput('enabled', false);
    await fixture.whenStable();
    expect(notifications.start).toHaveBeenCalledOnce();
    banner.set(testMessage);
    await fixture.whenStable();
    expect(banner()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.notification')).toBeNull();
  });

  it('opens the exact message and allows dismissal', async () => {
    const fixture = TestBed.createComponent(NotificationBanner);
    fixture.componentRef.setInput('enabled', true);
    banner.set(testMessage);
    await fixture.whenStable();
    fixture.nativeElement.querySelector('.message').click();
    expect(notifications.open).toHaveBeenCalledWith(testMessage.chatId, testMessage.id, testMessage.replyRootId);
    fixture.nativeElement.querySelector('.close').click();
    await fixture.whenStable();
    expect(banner()).toBeUndefined();
  });
});
