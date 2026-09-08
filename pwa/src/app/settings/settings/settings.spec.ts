import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectorRef, Component, getDebugNode, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { IonNav, ModalController, provideIonicAngular } from '@ionic/angular';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { FriendAddVerificationMode as Mode, type FriendSettingsResponse } from '../../../generated/models';
import { jsonInterceptor } from '../../api/json.interceptor';
import { testUser } from '../../api/testing';
import { AppUpdates, UpdateCheckResult } from '../../pwa/app-updates';
import { PushNotificationError, PushNotifications } from '../../pwa/push-notifications';
import { SessionStore } from '../../session/session-store';
import { FriendVerificationSettings } from '../friend-verification-settings/friend-verification-settings';
import { Preferences } from '../preferences';
import { Settings, SettingsDismissRole } from './settings';

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
    subscribed: ReturnType<typeof signal<boolean>>;
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
      subscribed: signal(false),
      enabled: signal(false),
      busy: signal(false),
      error: signal<PushNotificationError | undefined>(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      setEnabled: vi.fn().mockResolvedValue(false),
    };
    updates = {
      supported: true,
      version: '0.0.0',
      checking: signal(false),
      available: signal(false),
      check: vi.fn().mockResolvedValue(UpdateCheckResult.Current),
      reload: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [SettingsHost],
      providers: [
        provideIonicAngular({ animated: false }),
        provideRouter([]),
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: SessionStore, useValue: { user: signal({ ...testUser, avatarUrl: '/avatar.jpg' }) } },
        { provide: ModalController, useValue: { dismiss } },
        { provide: PushNotifications, useValue: notifications },
        { provide: AppUpdates, useValue: updates },
      ],
    });
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

  async function followLink(button: HTMLElement) {
    const previous = page;
    button.click();
    await vi.waitFor(async () => {
      const active = (await nav.getActive())!.element!;
      expect(active).not.toBe(previous);
      page = active;
    });
  }

  async function openPage(label: string) {
    const item = Array.from(page.querySelectorAll('ion-item')).find((entry) => entry.textContent?.trim() === label)!;
    await followLink(item);
  }

  async function back() {
    await followLink(page.querySelector('ion-nav-link ion-button')!);
  }

  function friendPage() {
    return getDebugNode(page)!.componentInstance as FriendVerificationSettings;
  }

  function homePage() {
    return getDebugNode(page)!.componentInstance as Settings;
  }

  async function choose(mode: Mode) {
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
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function saveButton() {
    return Array.from(page.querySelectorAll('ion-button')).find((button) => button.textContent?.includes('保存'))!;
  }

  it('keeps general and verification controls on secondary pages instead of the settings home', () => {
    expect(page.textContent).toContain(testUser.username);
    expect(page.querySelector('ion-avatar img')!.getAttribute('src')).toBe('/avatar.jpg');
    expect(page.querySelectorAll('ion-toggle')).toHaveLength(1);
    expect(page.querySelector('ion-radio-group')).toBeNull();
    expect(page.textContent).not.toContain('在“消息”标签页中显示话题');
    expect(page.textContent).not.toContain('允许任何人添加我');
    http.expectNone(endpoint);
  });

  it('opens general settings, persists preferences and returns within the same modal', async () => {
    await openPage('通用');
    expect(page.querySelector('ion-title')!.textContent).toBe('通用');
    const toggles = Array.from(page.querySelectorAll('ion-toggle'));
    toggles[0].dispatchEvent(new CustomEvent('ionChange', { detail: { checked: false } }));
    toggles[1].dispatchEvent(new CustomEvent('ionChange', { detail: { checked: true } }));
    expect(TestBed.inject(Preferences).showThreadsInMessages()).toBe(false);
    expect(TestBed.inject(Preferences).showAllAvatars()).toBe(true);
    expect(localStorage.getItem('chahua.preferences.showThreadsInMessages')).toBe('false');
    expect(localStorage.getItem('chahua.preferences.showAllAvatars')).toBe('true');
    await back();
    expect(page.tagName).toBe('APP-SETTINGS');
    expect(await nav.canGoBack()).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
    await openPage('通用');
    const restored = Array.from(page.querySelectorAll('ion-toggle'));
    expect(restored[0].checked).toBe(false);
    expect(restored[1].checked).toBe(true);
    const done = Array.from(page.querySelectorAll('ion-button')).find(
      (button) => button.textContent?.trim() === '完成',
    )!;
    done.click();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('loads all four modes, requires a nonblank question and saves its trimmed text', async () => {
    await openPage('好友验证');
    await load({ mode: Mode.need_message });
    expect(Array.from(page.querySelectorAll('ion-radio')).map((radio) => radio.value)).toEqual([
      Mode.direct,
      Mode.need_message,
      Mode.question,
      Mode.forbid,
    ]);
    await choose(Mode.question);
    await enterQuestion('   ');
    expect(saveButton().disabled).toBe(true);
    await enterQuestion('  我们在哪里认识的？  ');
    expect(saveButton().disabled).toBe(false);
    saveButton().click();
    const request = http.expectOne(endpoint);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ mode: Mode.question, question: '我们在哪里认识的？' });
    request.flush({ mode: Mode.question, question: '我们在哪里认识的？' });
    await fixture.whenStable();
    expect(page.textContent).toContain('已保存');
    await back();
    expect(page.tagName).toBe('APP-SETTINGS');
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not retain a question when another verification mode is saved', async () => {
    await openPage('好友验证');
    await load({ mode: Mode.question, question: '旧问题' });
    await choose(Mode.forbid);
    expect(page.querySelector('ion-textarea')).toBeNull();
    saveButton().click();
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
    const saving = friendPage()['saveVerification']();
    await friendPage()['saveVerification']();
    http.expectOne(endpoint).flush('', { status: 503, statusText: 'Unavailable' });
    await saving;
    await fixture.whenStable();
    expect(page.textContent).toContain('保存失败，请重试');
    expect(friendPage()['verification']().mode).toBe(Mode.need_message);
    const retry = friendPage()['saveVerification']();
    http.expectOne(endpoint).flush({ mode: Mode.need_message });
    await retry;
    await fixture.whenStable();
    expect(page.textContent).toContain('已保存');
  });

  it('requests saved-message navigation through the modal dismissal', async () => {
    await homePage()['openSaved']();
    expect(dismiss).toHaveBeenCalledWith(undefined, SettingsDismissRole.Saved);
  });

  it('refreshes notification status without requesting permission and rolls back a denied toggle', async () => {
    expect(notifications.refresh).toHaveBeenCalledOnce();
    expect(notifications.setEnabled).not.toHaveBeenCalled();
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
    expect(page.textContent).toContain('通知权限已被拒绝');
  });

  it('replaces unsupported notifications with a note and disables the update row', async () => {
    notifications.supported = false;
    updates.supported = false;
    getDebugNode(page)!.injector.get(ChangeDetectorRef).markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.querySelector('ion-toggle')).toBeNull();
    const items = Array.from(page.querySelectorAll('ion-item'));
    expect(items.find((item) => item.textContent?.includes('消息通知'))?.textContent).toContain('不支持');
    expect(items.find((item) => item.textContent?.includes('检查更新'))?.disabled).toBe(true);
  });

  it('shows the version and check result, then reloads only when the update button is chosen', async () => {
    expect(page.textContent).toContain('PWA2-0.0.0');
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
