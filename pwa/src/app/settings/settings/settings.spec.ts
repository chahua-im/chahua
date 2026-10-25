import { GeneralSettings } from '../general-settings/general-settings';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectorRef, Component, getDebugNode, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { IonNav, ModalController, provideIonicAngular } from '@ionic/angular';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import {
  FriendAddVerificationMode as Mode,
  PresenceVisibility,
  type FriendSettingsResponse,
  type PresenceSettingsResponse,
} from '../../../generated/models';
import { jsonInterceptor } from '../../api/json.interceptor';
import { Connection } from '../../api/connection';
import { mockRealtime, testUser } from '../../api/testing';
import { AppUpdates, UpdateCheckResult } from '../../pwa/app-updates';
import { Presence } from '../../presence/presence';
import { PushNotificationError, PushNotifications } from '../../pwa/push-notifications';
import { SessionStore } from '../../session/session-store';
import { ColorMode } from '../color-mode';
import { FriendVerificationSettings } from '../friend-verification-settings/friend-verification-settings';
import { Preferences } from '../preferences';
import { PrivacySettings } from '../privacy-settings/privacy-settings';
import { PresenceSettings } from '../presence-settings/presence-settings';
import { StickerSettings } from '../sticker-settings/sticker-settings';
import { StickerPreferences } from '../sticker-preferences';
import { NotificationSettings } from '../notification-settings/notification-settings';
import { Settings } from './settings';

@Component({ imports: [IonNav], template: '<ion-nav [root]="root"></ion-nav>' })
class SettingsHost {
  readonly root = Settings;
}

describe('Settings', () => {
  let fixture: ComponentFixture<SettingsHost>;
  let nav: HTMLIonNavElement;
  let page: HTMLElement;
  let http: HttpTestingController;
  let dismiss: ReturnType<typeof vi.fn>;
  let notifications: {
    supported: boolean;
    permission: ReturnType<typeof signal<NotificationPermission>>;
    enabled: ReturnType<typeof signal<boolean>>;
    busy: ReturnType<typeof signal<boolean>>;
    error: ReturnType<typeof signal<PushNotificationError | undefined>>;
    refresh: ReturnType<typeof vi.fn>;
    setEnabled: ReturnType<typeof vi.fn>;
  };
  let updates: {
    supported: boolean;
    version: string;
    checking: ReturnType<typeof signal<boolean>>;
    available: ReturnType<typeof signal<boolean>>;
    check: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
  };
  let presence: { invalidateUsers: () => void };
  const presenceEndpoint = '/_api/me/presence-settings';
  const endpoint = '/_api/friends/me/settings';

  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    dismiss = vi.fn().mockResolvedValue(true);
    notifications = {
      supported: true,
      permission: signal<NotificationPermission>('granted'),
      enabled: signal(false),
      busy: signal(false),
      error: signal<PushNotificationError | undefined>(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      setEnabled: vi.fn().mockResolvedValue(false),
    };
    updates = {
      supported: true,
      version: 'PWA2-1234',
      checking: signal(false),
      available: signal(false),
      check: vi.fn().mockResolvedValue(UpdateCheckResult.Current),
      reload: vi.fn(),
    };
    presence = { invalidateUsers: vi.fn() };
    TestBed.configureTestingModule({
      imports: [SettingsHost],
      providers: [
        provideIonicAngular({ animated: false }),
        provideRouter([]),
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime() },
        SessionStore,
        { provide: ModalController, useValue: { dismiss } },
        { provide: PushNotifications, useValue: notifications },
        { provide: AppUpdates, useValue: updates },
        { provide: Presence, useValue: presence },
        {
          provide: StickerPreferences,
          useValue: {
            autoSortPacksEnabled: signal(false),
            autoSortFavoritesEnabled: signal(false),
            packOrder: signal([]),
            upsertPackOrderItem: vi.fn(),
            syncPackOrder: vi.fn(async () => {}),
          },
        },
      ],
    });
    TestBed.inject(SessionStore).user.set({ ...testUser, avatarUrl: '/avatar.jpg' });
    vi.spyOn(TestBed.inject(SessionStore), 'devUid').mockReturnValue(1);
    vi.spyOn(TestBed.inject(SessionStore), 'switchDevUid').mockImplementation(() => {});
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SettingsHost);
    fixture.detectChanges();
    nav = fixture.nativeElement.querySelector('ion-nav');
    await vi.waitFor(async () => {
      const active = await nav.getActive();
      expect(active?.element).toBeDefined();
      page = active!.element!;
    });
    await fixture.whenStable();
  });

  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
  });

  async function load(settings: FriendSettingsResponse = { mode: Mode.direct }) {
    http.expectOne(endpoint).flush(settings);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function loadPresence(settings: PresenceSettingsResponse = { visibility: PresenceVisibility.everyone }) {
    http.expectOne(presenceEndpoint).flush(settings);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function openPage(label: '聊天设置' | '好友验证' | '在线状态隐私') {
    if (label !== '聊天设置') {
      const privacy = page.querySelector('ion-item[href="/settings/privacy"]');
      expect(privacy).not.toBeNull();
      expect(page.querySelector('ion-item[href="/settings/read-receipts"]')).toBeNull();
      await nav.push(PrivacySettings);
      page = (await nav.getActive())!.element!;
      TestBed.tick();
      http.expectOne('/_api/blocks').flush({ blocks: [] });
      http.expectOne('/_api/me/read-receipt-settings').flush({ visibility: 'friends' });
      http.expectOne(endpoint).flush({ mode: Mode.direct });
      http.expectOne(presenceEndpoint).flush({ visibility: PresenceVisibility.everyone });
      await fixture.whenStable();
    }
    const destination =
      label === '聊天设置'
        ? { component: GeneralSettings, route: '/settings/general' }
        : label === '好友验证'
          ? { component: FriendVerificationSettings, route: '/settings/friend-verification' }
          : { component: PresenceSettings, route: '/settings/presence' };
    expect(page.querySelector(`ion-item[href="${destination.route}"]`)).not.toBeNull();
    await nav.push(destination.component);
    page = (await nav.getActive())!.element!;
    await fixture.whenStable();
  }

  async function openNotifications() {
    expect(page.querySelector('ion-item[href="/settings/notifications"]')).not.toBeNull();
    await nav.push(NotificationSettings);
    page = (await nav.getActive())!.element!;
    TestBed.tick();
    http
      .expectOne('/_api/users/me/notification-exceptions?kind=group&limit=1')
      .flush({ exceptions: [], totalCount: 0 });
    http.expectOne('/_api/users/me/notification-exceptions?kind=dm&limit=1').flush({ exceptions: [], totalCount: 0 });
    await fixture.whenStable();
  }

  async function back() {
    page.querySelector<HTMLElement>('ion-buttons[slot="start"] ion-button')!.click();
    expect(dismiss).toHaveBeenCalledOnce();
    dismiss.mockClear();
    await nav.pop();
    page = (await nav.getActive())!.element!;
  }

  function friendPage() {
    return getDebugNode(page)!.componentInstance as FriendVerificationSettings;
  }

  function homePage() {
    return getDebugNode(page)!.componentInstance as Settings;
  }

  async function choose(mode: Mode | PresenceVisibility) {
    const group: HTMLIonRadioGroupElement = page.querySelector('ion-radio-group')!;
    group.value = mode;
    group.dispatchEvent(new CustomEvent('ionChange', { detail: { value: mode } }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function enterQuestion(question: string) {
    const textarea: HTMLIonTextareaElement = page.querySelector('ion-textarea')!;
    textarea.value = question;
    textarea.dispatchEvent(new CustomEvent('ionInput', { detail: { value: question } }));
    textarea.dispatchEvent(new CustomEvent('ionChange', { detail: { value: question } }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('keeps general and verification controls on secondary pages instead of the settings home', () => {
    expect(page.textContent).toContain(testUser.username);
    expect(page.querySelector('ion-avatar img')!.getAttribute('src')).toBe('/avatar.jpg');
    expect(page.querySelectorAll('ion-toggle')).toHaveLength(0);
    expect(page.querySelector('ion-radio-group')).toBeNull();
    expect(page.textContent).not.toContain('在“消息”标签页中显示话题');
    expect(page.textContent).not.toContain('允许任何人');
    http.expectNone(endpoint);
    http.expectNone(presenceEndpoint);
  });

  it('keeps chat preferences on the chat settings page and preserves saved choices', async () => {
    await openPage('聊天设置');
    expect(page.querySelector('ion-title')!.textContent).toBe('聊天设置');
    expect(page.textContent).not.toContain('语言');
    const range = page.querySelector('ion-range')!;
    range.dispatchEvent(new CustomEvent('ionInput', { detail: { value: 4 } }));
    expect(TestBed.inject(Preferences).chatFontSize()).toBe(4);
    expect(localStorage.getItem('chahua.preferences.chatFontSize')).toBe('4');
    await fixture.whenStable();
    const preview = page.querySelector<HTMLElement>('.font-preview')!;
    expect(preview.style.getPropertyValue('--preview-font-size')).toBe('20px');
    expect(preview.querySelectorAll('.preview-message')).toHaveLength(2);
    range.dispatchEvent(new CustomEvent('ionInput', { detail: { value: 2 } }));
    await fixture.whenStable();
    expect(preview.style.getPropertyValue('--preview-font-size')).toBe('');
    expect(preview.style.getPropertyValue('--preview-line-height')).toBe('');
    const toggles = Array.from(page.querySelectorAll('ion-toggle'));
    expect(toggles[2].checked).toBe(true);
    expect(toggles).toHaveLength(4);
    expect(toggles[3].textContent).toContain('显示群成员进出群消息');
    toggles[0].dispatchEvent(new CustomEvent('ionChange', { detail: { checked: false } }));
    toggles[1].dispatchEvent(new CustomEvent('ionChange', { detail: { checked: true } }));
    toggles[2].dispatchEvent(new CustomEvent('ionChange', { detail: { checked: false } }));
    expect(TestBed.inject(Preferences).showThreadsInMessages()).toBe(false);
    expect(TestBed.inject(Preferences).showAllAvatars()).toBe(true);
    expect(TestBed.inject(Preferences).showDmDetails()).toBe(false);
    expect(localStorage.getItem('chahua.preferences.showThreadsInMessages')).toBe('false');
    expect(localStorage.getItem('chahua.preferences.showAllAvatars')).toBe('true');
    expect(localStorage.getItem('chahua.preferences.showDmDetails')).toBe('false');
    await back();
    expect(page.tagName).toBe('APP-SETTINGS');
    expect(await nav.canGoBack()).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
    await openPage('聊天设置');
    const restored = Array.from(page.querySelectorAll('ion-toggle'));
    expect(restored[0].checked).toBe(false);
    expect(restored[1].checked).toBe(true);
    expect(restored[2].checked).toBe(false);
    const done = Array.from(page.querySelectorAll('ion-button')).find(
      (button) => button.textContent?.trim() === '完成',
    )!;
    done.click();
    expect(dismiss).toHaveBeenCalledOnce();
    dismiss.mockClear();
    await back();
    TestBed.inject(SessionStore).user.update((user) => user && { ...user, showMembershipMessages: false });
    await openPage('聊天设置');
    expect(page.querySelector('ion-title')!.textContent).toBe('聊天设置');
    expect(page.querySelectorAll('ion-toggle')).toHaveLength(4);
    const membership = page.querySelectorAll('ion-toggle')[3];
    expect(membership.textContent).toContain('显示群成员进出群消息');
    expect(membership.checked).toBe(false);
    membership.dispatchEvent(new CustomEvent('ionChange', { detail: { checked: true } }));
    await fixture.whenStable();
    expect(membership.disabled).toBe(true);
    expect(TestBed.inject(Preferences).showMembershipMessages()).toBe(false);
    const save = http.expectOne('/_api/users/me/chat-settings');
    expect(save.request.method).toBe('PUT');
    expect(save.request.body).toEqual({ showMembershipMessages: true });
    save.flush({ showMembershipMessages: true });
    await fixture.whenStable();
    expect(TestBed.inject(Preferences).showMembershipMessages()).toBe(true);
    expect(localStorage.getItem('chahua.preferences.showMembershipMessages')).toBeNull();
    await back();
    await openPage('聊天设置');
    expect(page.querySelectorAll('ion-toggle')[3].checked).toBe(true);
  });

  it('restores the saved membership choice on failure and allows retrying the toggle', async () => {
    await openPage('聊天设置');
    const toggle = page.querySelectorAll('ion-toggle')[3];
    toggle.checked = false;
    toggle.dispatchEvent(new CustomEvent('ionChange', { detail: { checked: false } }));
    await fixture.whenStable();
    expect(toggle.disabled).toBe(true);
    expect(page.querySelector('ion-spinner')).not.toBeNull();
    http.expectOne('/_api/users/me/chat-settings').flush('', { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(toggle.checked).toBe(true));
    await fixture.whenStable();
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(TestBed.inject(Preferences).showMembershipMessages()).toBe(true);
    expect(page.textContent).toContain('保存失败，请重试。');
    toggle.dispatchEvent(new CustomEvent('ionChange', { detail: { checked: false } }));
    http.expectOne('/_api/users/me/chat-settings').flush({ showMembershipMessages: false });
    await fixture.whenStable();
    expect(toggle.checked).toBe(false);
    expect(TestBed.inject(Preferences).showMembershipMessages()).toBe(false);
    expect(page.textContent).not.toContain('保存失败，请重试。');
  });

  it('switches and persists the color mode from general settings', async () => {
    await openPage('聊天设置');
    expect(Array.from(page.querySelectorAll('ion-radio')).map((radio) => radio.value)).toEqual([
      ColorMode.System,
      ColorMode.Light,
      ColorMode.Dark,
    ]);
    const group: HTMLIonRadioGroupElement = page.querySelector('ion-radio-group')!;
    group.value = ColorMode.Dark;
    group.dispatchEvent(new CustomEvent('ionChange', { detail: { value: ColorMode.Dark } }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(TestBed.inject(Preferences).colorMode()).toBe(ColorMode.Dark);
    expect(localStorage.getItem('chahua.preferences.colorMode')).toBe('dark');
  });

  it('requires Apply for question mode and saves its trimmed text only after confirmation', async () => {
    await openPage('好友验证');
    await load({ mode: Mode.need_message });
    expect(Array.from(page.querySelectorAll('ion-radio')).map((radio) => radio.value)).toEqual([
      Mode.direct,
      Mode.need_message,
      Mode.question,
      Mode.forbid,
    ]);
    expect(
      Array.from(page.querySelectorAll('ion-button')).some((button) => button.textContent?.trim() === '应用'),
    ).toBe(false);
    await choose(Mode.question);
    await enterQuestion('   ');
    const apply = Array.from(page.querySelectorAll('ion-button')).find(
      (button) => button.textContent?.trim() === '应用',
    )!;
    expect(apply.disabled).toBe(true);
    http.expectNone(endpoint);
    expect(page.textContent).toContain('请填写 1–100 字的问题');
    await enterQuestion('  我们在哪里认识的？  ');
    http.expectNone(endpoint);
    expect(apply.disabled).toBe(false);
    apply.click();
    const request = http.expectOne(endpoint);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ mode: Mode.question, question: '我们在哪里认识的？' });
    request.flush({ mode: Mode.question, question: '我们在哪里认识的？' });
    await fixture.whenStable();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.textContent).toContain('已保存');
    });
    await back();
    expect(page.tagName).toBe('APP-PRIVACY-SETTINGS');
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('loads and saves presence privacy, invalidating all individual presence snapshots', async () => {
    await openPage('在线状态隐私');
    await loadPresence();
    expect(Array.from(page.querySelectorAll('ion-radio')).map((radio) => radio.value)).toEqual([
      PresenceVisibility.everyone,
      PresenceVisibility.friends,
      PresenceVisibility.nobody,
    ]);
    expect(
      Array.from(page.querySelectorAll('ion-button')).some((button) => button.textContent?.trim() === '保存'),
    ).toBe(false);
    await choose(PresenceVisibility.nobody);
    await choose(PresenceVisibility.friends);
    const request = http.expectOne(presenceEndpoint);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ visibility: PresenceVisibility.nobody });
    request.flush({ visibility: PresenceVisibility.nobody });
    await fixture.whenStable();
    expect(presence.invalidateUsers).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.textContent).toContain('已保存');
    });
  });

  it('does not retain a question when another verification mode is saved', async () => {
    await openPage('好友验证');
    await load({ mode: Mode.question, question: '旧问题' });
    await choose(Mode.forbid);
    expect(page.querySelector('ion-textarea')).toBeNull();
    expect(
      Array.from(page.querySelectorAll('ion-button')).some((button) => button.textContent?.trim() === '应用'),
    ).toBe(false);
    const request = http.expectOne(endpoint);
    expect(request.request.body).toEqual({ mode: Mode.forbid });
    request.flush({ mode: Mode.forbid });
    await fixture.whenStable();
    expect(friendPage()['verification']()).toEqual({ mode: Mode.forbid, question: '' });
  });

  it('retries a failed initial load before allowing settings to be changed', async () => {
    await openPage('好友验证');
    http.expectOne(endpoint).flush('', { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(page.querySelector('ion-radio-group')).toBeNull();
    expect(page.textContent).toContain('好友验证设置加载失败');
    const retry = Array.from(page.querySelectorAll('ion-button')).find((button) =>
      button.textContent?.includes('重试'),
    )!;
    retry.click();
    await load({ mode: Mode.need_message });
    expect(friendPage()['verification']().mode).toBe(Mode.need_message);
  });

  it('keeps a failed edit available for retry and prevents overlapping saves', async () => {
    await openPage('好友验证');
    await load();
    await choose(Mode.need_message);
    await friendPage()['saveVerification']();
    http.expectOne(endpoint).flush('', { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.textContent).toContain('保存失败，请重试');
    });
    expect(friendPage()['verification']().mode).toBe(Mode.need_message);
    Array.from(page.querySelectorAll('ion-button'))
      .find((button) => button.textContent?.includes('重试'))!
      .click();
    http.expectOne(endpoint).flush({ mode: Mode.need_message });
    await fixture.whenStable();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.textContent).toContain('已保存');
    });
  });

  it('links to the sticker settings page and loads its pack list', async () => {
    const item = Array.from(page.querySelectorAll('ion-item')).find(
      (entry) => entry.textContent?.trim() === '表情和贴纸',
    )!;
    expect(item.getAttribute('href')).toBe('/settings/stickers');
    await nav.push(StickerSettings);
    page = (await nav.getActive())!.element!;
    http.expectOne('/_api/stickers/packs/mine/owned').flush({ packs: [] });
    http.expectOne('/_api/stickers/packs/mine/subscribed').flush({ packs: [] });
    await fixture.whenStable();
    expect(page.querySelector('ion-title')!.textContent).toBe('表情和贴纸');
  });

  it('keeps the requested menu order and requests permission only from its button', async () => {
    expect(
      Array.from(page.querySelectorAll('ion-list')[0].querySelectorAll('ion-label')).map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['消息通知', '隐私', '聊天设置', '表情和贴纸', '语言']);
    expect(page.querySelector('ion-item[href="/settings/experimental"]')).toBeNull();
    expect(page.querySelector('ion-toggle')).toBeNull();
    expect(notifications.refresh).not.toHaveBeenCalled();
    notifications.permission.set('default');
    await openNotifications();
    expect(page.querySelector('ion-toggle')!.disabled).toBe(true);
    const button = Array.from(page.querySelectorAll('ion-button')).find((item) =>
      item.textContent?.includes('申请通知权限'),
    )!;
    button.click();
    expect(notifications.setEnabled).toHaveBeenCalledWith(true);
    notifications.permission.set('granted');
    notifications.enabled.set(true);
    await fixture.whenStable();
    expect(page.textContent).not.toContain('申请通知权限');
    expect(page.querySelector('ion-toggle')!.disabled).toBe(false);
    expect(page.querySelector('ion-toggle')!.checked).toBe(true);
    await back();
    expect(page.tagName).toBe('APP-SETTINGS');
  });

  it('refreshes notification status without requesting permission and rolls back a denied toggle', async () => {
    await openNotifications();
    expect(notifications.refresh).toHaveBeenCalledOnce();
    expect(notifications.setEnabled).not.toHaveBeenCalled();
    const toast = vi
      .spyOn((getDebugNode(page)!.componentInstance as NotificationSettings)['permissionToast'](), 'present')
      .mockResolvedValue();
    notifications.setEnabled.mockImplementation(async () => {
      notifications.error.set(PushNotificationError.PermissionDenied);
      return false;
    });
    const toggle = page.querySelector('ion-toggle')!;
    toggle.checked = true;
    toggle.dispatchEvent(new CustomEvent('ionChange', { detail: { checked: true } }));
    expect(notifications.setEnabled).toHaveBeenCalledWith(true);
    await fixture.whenStable();
    expect(toggle.checked).toBe(false);
    expect(toast).toHaveBeenCalledOnce();
    expect(page.querySelector('ion-list')!.textContent).not.toContain('通知权限已被拒绝');
  });

  it('shows blocked permission guidance, refreshes on focus and retries worker failures', async () => {
    notifications.permission.set('denied');
    await openNotifications();
    expect(page.textContent).toContain('浏览器的网站设置');
    expect(page.textContent).not.toContain('申请通知权限');
    notifications.refresh.mockClear();
    window.dispatchEvent(new Event('focus'));
    expect(notifications.refresh).toHaveBeenCalledOnce();
    notifications.permission.set('granted');
    notifications.enabled.set(true);
    notifications.error.set(PushNotificationError.ServiceWorkerUnavailable);
    await fixture.whenStable();
    expect(page.textContent).toContain('通知服务暂不可用');
    Array.from(page.querySelectorAll('ion-button'))
      .find((button) => button.textContent?.includes('重试'))!
      .click();
    expect(notifications.setEnabled).toHaveBeenCalledWith(true);
  });

  it('replaces unsupported notifications with a note and disables the update row', async () => {
    notifications.supported = false;
    updates.supported = false;
    getDebugNode(page)!.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.querySelector('ion-toggle')).toBeNull();
    const items = Array.from(page.querySelectorAll('ion-item'));
    expect(items.find((item) => item.textContent?.includes('检查更新'))?.disabled).toBe(true);
    await openNotifications();
    expect(page.textContent).toContain('不支持');
    expect(page.querySelector('ion-toggle')!.disabled).toBe(true);
    expect(page.textContent).not.toContain('申请通知权限');
  });

  it('shows the version and check result, then reloads only when the update button is chosen', async () => {
    const updateRow = Array.from(page.querySelectorAll('ion-item')).find((item) =>
      item.textContent?.includes('检查更新'),
    )!;
    expect(updateRow.querySelector('ion-note')?.textContent?.trim()).toBe('PWA2-1234');
    await homePage()['checkUpdates']();
    await fixture.whenStable();
    expect(page.textContent).toContain('已是最新版本');
    updates.available.set(true);
    await fixture.whenStable();
    expect(updates.reload).not.toHaveBeenCalled();
    const reload = Array.from(page.querySelectorAll('ion-button')).find((button) =>
      button.textContent?.includes('立即更新'),
    )!;
    reload.click();
    expect(updates.reload).toHaveBeenCalledOnce();
  });
});
