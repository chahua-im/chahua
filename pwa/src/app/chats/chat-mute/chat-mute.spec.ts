import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { IonActionSheet } from '@ionic/angular';
import { vi } from 'vitest';
import { GroupKind, NotificationSettingMode } from '../../../generated/models';
import { testChat, testUser } from '../../api/testing';
import { SessionStore } from '../../session/session-store';
import { ChatStore } from '../chat-store';
import { ChatMute } from './chat-mute';

describe('chat notification menu', () => {
  const user = signal(testUser);
  const kind = signal(GroupKind.group);
  const state = signal<{ muteOverride?: boolean; mutedUntil?: string }>({});
  const now = signal(Date.now());
  const save = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    user.set(testUser);
    save.mockClear();
    kind.set(GroupKind.group);
    state.set({});
    now.set(Date.now());
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionStore, useValue: { user } },
        {
          provide: ChatStore,
          useValue: {
            setNotificationSetting: save,
            get: () => ({ kind: kind() }),
            chatState: state,
            isTemporarilyMuted: () => Date.parse(state().mutedUntil ?? '') > now(),
            notificationDefaults: user,
          },
        },
      ],
    });
    vi.spyOn(IonActionSheet.prototype, 'present').mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    NotificationSettingMode.inherit,
    NotificationSettingMode.alwaysMuted,
    NotificationSettingMode.alwaysUnmuted,
  ])('submits %s only after a selection', async (mode) => {
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockResolvedValue({ role: 'selected', data: { mode } });
    const fixture = TestBed.createComponent(ChatMute);
    fixture.detectChanges();
    await fixture.componentInstance.toggle(testChat.id);
    expect(save).toHaveBeenCalledExactlyOnceWith(testChat.id, { mode });
  });

  it('cancels without changing notification preferences', async () => {
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockResolvedValue({ role: 'cancel' });
    const fixture = TestBed.createComponent(ChatMute);
    fixture.detectChanges();
    await fixture.componentInstance.toggle(testChat.id);
    expect(save).not.toHaveBeenCalled();
  });

  it('ignores duplicate taps and a selection made after switching accounts', async () => {
    let dismiss!: (value: { role: string; data: { mode: NotificationSettingMode } }) => void;
    const result = new Promise<{ role: string; data: { mode: NotificationSettingMode } }>((resolve) => {
      dismiss = resolve;
    });
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockReturnValue(result);
    const fixture = TestBed.createComponent(ChatMute);
    fixture.detectChanges();
    const opening = fixture.componentInstance.toggle(testChat.id);
    await fixture.componentInstance.toggle(testChat.id);
    expect(IonActionSheet.prototype.present).toHaveBeenCalledOnce();
    user.set({ ...testUser, uid: 2 });
    dismiss({ role: 'selected', data: { mode: NotificationSettingMode.alwaysMuted } });
    await opening;
    expect(save).not.toHaveBeenCalled();
  });
  it.each([
    [GroupKind.group, undefined, true, false],
    [GroupKind.group, false, true, true],
    [GroupKind.group, true, false, false],
    [GroupKind.group, undefined, false, true],
    [GroupKind.dm, undefined, false, true],
    [GroupKind.dm, true, false, false],
    [GroupKind.dm, undefined, true, false],
    [GroupKind.dm, false, true, true],
  ] as const)(
    'filters temporary options before presenting %s, override %s, default %s',
    async (chatKind, override, defaultMuted, visible) => {
      kind.set(chatKind);
      state.set({ muteOverride: override, mutedUntil: new Date(Date.now() + 3600000).toISOString() });
      user.set({ ...testUser, muteGroupChatsByDefault: defaultMuted, muteDirectChatsByDefault: defaultMuted });
      vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockResolvedValue({ role: 'cancel' });
      vi.spyOn(IonActionSheet.prototype, 'present').mockImplementation(async function (this: IonActionSheet) {
        const temporary = this.buttons.filter(
          (button) => typeof button !== 'string' && button.data?.mode === NotificationSettingMode.temporarilyMuted,
        );
        expect(temporary.map((button) => (typeof button === 'string' ? button : button.text))).toEqual(
          visible ? ['静音 1 小时', '静音 8 小时', '静音 1 天', '静音 7 天'] : [],
        );
        expect(this.buttons).toHaveLength(visible ? 8 : 4);
      });
      const fixture = TestBed.createComponent(ChatMute);
      fixture.detectChanges();
      await fixture.componentInstance.toggle(testChat.id);
    },
  );

  it.each([undefined, false, true])('hides only the current preference for override %s', async (override) => {
    state.set({ muteOverride: override, mutedUntil: new Date(Date.now() - 1000).toISOString() });
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockResolvedValue({ role: 'cancel' });
    vi.spyOn(IonActionSheet.prototype, 'present').mockImplementation(async function (this: IonActionSheet) {
      const modes = this.buttons.flatMap((button) => (typeof button === 'string' ? [] : [button.data?.mode]));
      expect(modes.includes(NotificationSettingMode.inherit)).toBe(override != null);
      expect(modes.includes(NotificationSettingMode.alwaysMuted)).toBe(override !== true);
      expect(modes.includes(NotificationSettingMode.alwaysUnmuted)).toBe(override !== false);
    });
    const fixture = TestBed.createComponent(ChatMute);
    fixture.detectChanges();
    await fixture.componentInstance.toggle(testChat.id);
  });

  it('hides the current preference when a temporary mute expires while the menu is open', async () => {
    const expires = Date.now() + 1000;
    state.set({ mutedUntil: new Date(expires).toISOString() });
    let dismiss!: (value: { role: string }) => void;
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockReturnValue(
      new Promise((resolve) => {
        dismiss = resolve;
      }),
    );
    const fixture = TestBed.createComponent(ChatMute);
    fixture.detectChanges();
    const opening = fixture.componentInstance.toggle(testChat.id);
    const sheet = fixture.debugElement.query(By.directive(IonActionSheet)).componentInstance as IonActionSheet;
    const inherits = () =>
      sheet.buttons.some(
        (button) => typeof button !== 'string' && button.data?.mode === NotificationSettingMode.inherit,
      );
    expect(inherits()).toBe(true);
    now.set(expires);
    fixture.detectChanges();
    expect(inherits()).toBe(false);
    dismiss({ role: 'cancel' });
    await opening;
  });

  it('updates an open menu when account defaults or the chat exception change', async () => {
    let dismiss!: (value: { role: string }) => void;
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockReturnValue(
      new Promise((resolve) => {
        dismiss = resolve;
      }),
    );
    const fixture = TestBed.createComponent(ChatMute);
    fixture.detectChanges();
    const opening = fixture.componentInstance.toggle(testChat.id);
    const sheet = fixture.debugElement.query(By.directive(IonActionSheet)).componentInstance as IonActionSheet;
    expect(sheet.buttons).toHaveLength(3);
    user.set({ ...testUser, muteGroupChatsByDefault: false });
    fixture.detectChanges();
    expect(sheet.buttons).toHaveLength(7);
    state.set({ muteOverride: true });
    fixture.detectChanges();
    expect(sheet.buttons).toHaveLength(3);
    dismiss({ role: 'cancel' });
    await opening;
  });
});
