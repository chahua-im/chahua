import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { PushNotifications } from '../push-notifications';
import { NotificationPrompt } from './notification-prompt';

describe('NotificationPrompt', () => {
  const notifications = {
    shouldPrompt: vi.fn(),
    declinePermission: vi.fn(),
    setEnabled: vi.fn(),
  };

  beforeEach(() => {
    notifications.shouldPrompt.mockReset().mockReturnValue(true);
    notifications.declinePermission.mockReset();
    notifications.setEnabled.mockReset().mockResolvedValue(false);
    TestBed.configureTestingModule({ providers: [{ provide: PushNotifications, useValue: notifications }] });
    TestBed.overrideComponent(NotificationPrompt, { set: { template: '<ion-toast />' } });
  });

  const createPrompt = () => {
    const fixture = TestBed.createComponent(NotificationPrompt);
    fixture.detectChanges();
    const prompt = fixture.componentInstance;
    vi.spyOn(prompt['toast'](), 'dismiss').mockResolvedValue(false);
    vi.spyOn(prompt['toast'](), 'present').mockResolvedValue();
    return prompt;
  };

  it('opens only when this device needs an initial permission choice', () => {
    notifications.shouldPrompt.mockReturnValue(false);
    const prompt = createPrompt();
    expect(prompt['open']()).toBe(false);
    expect(notifications.setEnabled).not.toHaveBeenCalled();
  });

  it('remembers refusal and closes immediately without requesting permission', () => {
    const prompt = createPrompt();
    expect(prompt['open']()).toBe(true);
    expect(prompt['decline']()).toBe(false);
    expect(prompt['open']()).toBe(false);
    expect(notifications.declinePermission).toHaveBeenCalledOnce();
    expect(notifications.setEnabled).not.toHaveBeenCalled();
  });

  it('starts authorization in the click handler and keeps the alert pending until success', async () => {
    let finish!: (enabled: boolean) => void;
    notifications.setEnabled.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
    const prompt = createPrompt();
    const request = prompt['allow']();
    expect(notifications.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(prompt['requesting']()).toBe(true);
    expect(prompt['open']()).toBe(true);
    expect(await prompt['allow']()).toBe(false);
    expect(prompt['decline']()).toBe(false);
    expect(notifications.declinePermission).not.toHaveBeenCalled();
    expect(notifications.setEnabled).toHaveBeenCalledOnce();
    finish(true);
    expect(await request).toBe(false);
    expect(prompt['open']()).toBe(false);
    expect(prompt['requesting']()).toBe(false);
    expect(prompt['toast']().present).not.toHaveBeenCalled();
  });

  it('keeps the alert after failure, shows feedback, and permits another attempt', async () => {
    const prompt = createPrompt();
    await prompt['allow']();
    expect(prompt['open']()).toBe(true);
    expect(prompt['requesting']()).toBe(false);
    expect(prompt['toast']().dismiss).toHaveBeenCalledOnce();
    expect(prompt['toast']().present).toHaveBeenCalledOnce();
    notifications.setEnabled.mockResolvedValue(true);
    const retry = prompt['allow']();
    await retry;
    expect(notifications.setEnabled).toHaveBeenCalledTimes(2);
    expect(prompt['toast']().dismiss).toHaveBeenCalledTimes(2);
    expect(prompt['toast']().present).toHaveBeenCalledOnce();
    expect(prompt['open']()).toBe(false);
  });
});
