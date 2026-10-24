import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Navigation, Router, provideRouter } from '@angular/router';
import { getPlatforms, IonRouterOutlet } from '@ionic/angular';
import { afterAll, vi } from 'vitest';
import { testUser } from '../api/testing';
import { ListTab } from '../chats/list-tabs';
import { PushNotifications } from '../pwa/push-notifications';
import { AppUpdates } from '../pwa/app-updates';
import { SessionStore } from '../session/session-store';
import { App } from './app';

describe('App', () => {
  const session = {
    initialize: vi.fn<() => Promise<void>>(),
    restoreToken: vi.fn(),
    token: signal<string | undefined>('test-token'),
    user: signal<typeof testUser | undefined>(undefined),
  };

  beforeEach(async () => {
    session.initialize.mockReset().mockResolvedValue();
    session.restoreToken.mockReset();
    session.token.set('test-token');
    session.user.set(undefined);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: AppUpdates, useValue: { promptOpen: signal(false), setInteractive: vi.fn() } },
        { provide: PushNotifications, useValue: { start: vi.fn() } },
        provideRouter([]),
        { provide: SessionStore, useValue: session },
      ],
    }).compileComponents();
  });

  afterAll(() => vi.unstubAllGlobals());

  it('only restores the token synchronously on landing', () => {
    history.replaceState(null, '', '/landing?token=landing-token');
    try {
      TestBed.overrideComponent(App, { set: { template: '' } });
      const fixture = TestBed.createComponent(App);
      expect(session.restoreToken).toHaveBeenCalledOnce();
      expect(session.initialize).not.toHaveBeenCalled();
      expect(fixture.componentInstance['loading']()).toBe(false);
      expect(TestBed.inject(PushNotifications).start).not.toHaveBeenCalled();
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  it('requests update confirmation only after the authenticated app has rendered', async () => {
    TestBed.overrideComponent(App, { set: { template: '' } });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const updates = TestBed.inject(AppUpdates);
    expect(updates.setInteractive).toHaveBeenLastCalledWith(false);
    session.user.set(testUser);
    await fixture.whenStable();
    expect(updates.setInteractive).toHaveBeenLastCalledWith(true);
  });

  it('returns to automatic updates when a logged-in app navigates to landing', async () => {
    TestBed.overrideComponent(App, { set: { template: '' } });
    const router = TestBed.inject(Router);
    router.resetConfig([
      { path: 'chats', children: [] },
      { path: 'landing', children: [] },
    ]);
    try {
      session.user.set(testUser);
      const fixture = TestBed.createComponent(App);
      await router.navigateByUrl('/chats');
      await fixture.whenStable();
      const updates = TestBed.inject(AppUpdates);
      expect(updates.setInteractive).toHaveBeenLastCalledWith(true);
      await router.navigateByUrl('/landing');
      await fixture.whenStable();
      expect(updates.setInteractive).toHaveBeenLastCalledWith(false);
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  it('initializes login when installed PWA startup will redirect landing to chats', async () => {
    const platforms = getPlatforms();
    const original = [...platforms];
    history.replaceState(null, '', '/landing');
    try {
      platforms.push('pwa');
      TestBed.overrideComponent(App, { set: { template: '' } });
      const fixture = TestBed.createComponent(App);
      await fixture.whenStable();
      expect(session.initialize).toHaveBeenCalledOnce();
      expect(session.restoreToken).toHaveBeenCalledOnce();
    } finally {
      platforms.splice(0, platforms.length, ...original);
      history.replaceState(null, '', '/');
    }
  });

  describe('Escape navigation', () => {
    beforeEach(() => {
      TestBed.overrideComponent(App, { set: { template: '' } });
    });

    const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    const configure = async (url: string) => {
      const router = TestBed.inject(Router);
      router.resetConfig([
        { path: 'chats', children: [] },
        { path: 'chats/chat/:id', children: [] },
        { path: 'chats/chat/:id/thread/:threadId', children: [] },
      ]);
      const fixture = TestBed.createComponent(App);
      await router.navigateByUrl(url);
      await fixture.whenStable();
      return { router, fixture };
    };

    it('leaves a thread for the parent chat positioned at the thread root', async () => {
      const { router, fixture } = await configure('/chats/chat/123/thread/456');
      pressEscape();
      await fixture.whenStable();
      expect(router.url).toBe('/chats/chat/123#msg=456');
    });

    it('leaves a chat for the chat list', async () => {
      const { router, fixture } = await configure('/chats/chat/123');
      pressEscape();
      await fixture.whenStable();
      expect(router.url).toBe('/chats');
    });

    it('defers to a focused input', async () => {
      const { router, fixture } = await configure('/chats/chat/123');
      const input = document.createElement('input');
      document.body.append(input);
      input.focus();
      try {
        pressEscape();
        await fixture.whenStable();
        expect(router.url).toBe('/chats/chat/123');
      } finally {
        input.remove();
      }
    });

    it('defers to a presented Ionic overlay', async () => {
      const { router, fixture } = await configure('/chats/chat/123');
      const modal = document.createElement('ion-modal');
      document.body.append(modal);
      try {
        pressEscape();
        await fixture.whenStable();
        expect(router.url).toBe('/chats/chat/123');
      } finally {
        modal.remove();
      }
    });

    it('does not defer to a closed split-pane menu, which is visible without show-menu', async () => {
      const { router, fixture } = await configure('/chats/chat/123');
      const menu = document.createElement('ion-menu');
      menu.classList.add('menu-pane-visible', 'split-pane-side', 'menu-enabled');
      document.body.append(menu);
      try {
        pressEscape();
        await fixture.whenStable();
        expect(router.url).toBe('/chats');
      } finally {
        menu.remove();
      }
    });
  });

  describe('iOS visual viewport', () => {
    const platforms = getPlatforms();
    const originalPlatforms = [...platforms];
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };

    beforeEach(() => {
      platforms.splice(0, platforms.length, 'ios');
      vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(window.innerHeight);
      viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
      vi.stubGlobal('visualViewport', viewport);
      TestBed.overrideComponent(App, { set: { template: '' } });
    });

    afterEach(() => {
      TestBed.resetTestingModule();
      platforms.splice(0, platforms.length, ...originalPlatforms);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('leaves keyboard resizing and panning to the browser', () => {
      const scroll = vi.spyOn(window, 'scrollTo');
      TestBed.createComponent(App);
      const initialStyle = document.body.style.cssText;
      for (const [height, offsetTop, scale] of [
        [393, 404, 1],
        [420, 80, 1],
        [420, 80, 2],
        [797, 0, 1],
      ]) {
        Object.assign(viewport, { height, offsetTop, scale });
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
        expect(document.body.style.cssText).toBe(initialStyle);
      }
      expect(scroll).not.toHaveBeenCalled();
    });
  });

  it('starts notifications after an authenticated session is ready', async () => {
    TestBed.overrideComponent(App, { set: { template: '' } });
    let finish!: () => void;
    session.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const fixture = TestBed.createComponent(App);
    const notifications = TestBed.inject(PushNotifications);
    expect(notifications.start).not.toHaveBeenCalled();
    session.user.set(testUser);
    finish();
    await fixture.whenStable();
    expect(notifications.start).toHaveBeenCalledOnce();
  });

  it('finishes native history transitions instantly and restores other navigation animations', async () => {
    TestBed.overrideComponent(App, {
      set: { template: '<ion-router-outlet #outlet (stackWillChange)="prepareTransition(outlet)" />' },
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const outlet = fixture.debugElement.query(By.directive(IonRouterOutlet)).componentInstance as IonRouterOutlet;
    const currentNavigation = vi.spyOn(TestBed.inject(Router), 'currentNavigation');
    // jsdom uses Ionic's CSS fallback, which rounds a zero duration up to 1 ms.
    for (const [native, trigger, desktop, animated, duration] of [
      [true, 'popstate', false, true, 1],
      [false, 'popstate', false, true, 540],
      [true, 'imperative', false, true, 540],
      [undefined, 'popstate', false, true, 540],
      [false, 'imperative', true, false, 540],
    ] as const) {
      const event = new PopStateEvent('popstate');
      Object.defineProperty(event, 'hasUAVisualTransition', { value: native });
      window.dispatchEvent(event);
      currentNavigation.mockReturnValue({ trigger } as Navigation);
      fixture.componentInstance['splitPaneVisible'].set(desktop);
      outlet.stackWillChange.emit();
      const element: HTMLIonRouterOutletElement = fixture.nativeElement.querySelector('ion-router-outlet');
      expect(element.animated).toBe(animated);
      const animation = element.animation?.(element, {
        enteringEl: document.createElement('div'),
        leavingEl: document.createElement('div'),
        direction: 'back',
      });
      expect(animation?.getDuration()).toBe(duration);
      animation?.destroy();
    }
  });

  it('keeps sidebar selection across conversation and settings navigation until another list route is opened', async () => {
    TestBed.overrideComponent(App, { set: { template: '' } });
    const router = TestBed.inject(Router);
    router.resetConfig([
      { path: 'chats', data: { tab: ListTab.Messages }, children: [] },
      { path: 'chats/:tab', children: [] },
      { path: 'chats/chat/:id', children: [] },
    ]);
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    await router.navigateByUrl('/chats');
    const sidebar = fixture.componentInstance['sidebarSelection'];
    expect(sidebar().tab).toBe(ListTab.Messages);
    const archivedFriends = { tab: ListTab.Friends, archived: true, requestHistory: false };
    sidebar.set(archivedFriends);
    expect(router.url).toBe('/chats');
    await router.navigateByUrl('/chats?settings=1');
    expect(sidebar()).toEqual(archivedFriends);
    await router.navigateByUrl('/chats');
    expect(sidebar()).toEqual(archivedFriends);
    await router.navigateByUrl('/chats/chat/9007199254740993');
    expect(sidebar()).toEqual(archivedFriends);
    await router.navigateByUrl('/chats/groups');
    expect(sidebar()).toEqual({ tab: ListTab.Groups, archived: false, requestHistory: false });
  });

  it('guides users without a token to the announcement post without a link', () => {
    history.replaceState(null, '', '/landing');
    session.token.set(undefined);
    try {
      const fixture = TestBed.createComponent(App);
      fixture.detectChanges();
      const element: HTMLElement = fixture.nativeElement;
      expect(element.textContent).toContain('请重新进入茶话');
      expect(element.textContent).toContain('请前往茶话发布帖重新进入');
      expect(element.querySelector('ion-button, a, ion-router-outlet')).toBeNull();
      expect(session.restoreToken).toHaveBeenCalledOnce();
      expect(session.initialize).not.toHaveBeenCalled();
      expect(TestBed.inject(PushNotifications).start).not.toHaveBeenCalled();
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  it.each(['/chats', '/chats/join/example'])('starts a development session without a token at %s', async (path) => {
    history.replaceState(null, '', path);
    session.token.set(undefined);
    try {
      const fixture = TestBed.createComponent(App);
      fixture.detectChanges();
      expect(session.restoreToken).toHaveBeenCalledOnce();
      expect(session.initialize).toHaveBeenCalledOnce();
      expect(TestBed.inject(PushNotifications).start).not.toHaveBeenCalled();
      await fixture.whenStable();
      expect(TestBed.inject(AppUpdates).setInteractive).toHaveBeenLastCalledWith(false);
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  it('owns startup loading and clears a transient error when retrying', async () => {
    session.initialize.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('茶话暂时不可用');
    let finish!: () => void;
    session.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const retry = fixture.componentInstance['initialize']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-spinner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.entry-brand')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.entry-status').textContent.trim()).toBe('');
    expect(fixture.nativeElement.textContent).not.toContain('茶话暂时不可用');
    await fixture.componentInstance['initialize']();
    expect(session.initialize).toHaveBeenCalledTimes(2);
    finish();
    await retry;
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
  });

  it('explains rejected authorization separately from missing credentials', async () => {
    session.initialize.mockImplementationOnce(async () => {
      session.token.set(undefined);
      throw new HttpErrorResponse({ status: 401 });
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('登录状态已失效');
    expect(fixture.nativeElement.textContent).toContain('请前往茶话发布帖重新进入');
    expect(fixture.nativeElement.querySelector('ion-button, a')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-chat-list')).toBeNull();
    expect(TestBed.inject(AppUpdates).setInteractive).toHaveBeenLastCalledWith(false);
  });

  it.each([
    [0, '暂时无法连接茶话'],
    [403, '暂时无法进入茶话'],
    [500, '茶话暂时不可用'],
  ])('explains initialization failures (%s) and preserves the token', async (status, title) => {
    session.initialize.mockRejectedValueOnce(new HttpErrorResponse({ status }));
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain(title);
    expect(fixture.nativeElement.textContent).toContain('重试');
    expect(fixture.nativeElement.querySelectorAll('.entry-actions ion-button')).toHaveLength(1);
    expect(fixture.nativeElement.textContent).not.toContain('重新加载');
    expect(session.token()).toBe('test-token');
  });

  it('offers reload after a slow connection and clears the timer when login finishes', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    session.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    try {
      const fixture = TestBed.createComponent(App);
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).not.toContain('重新加载');
      await vi.advanceTimersByTimeAsync(10000);
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('连接比平时慢');
      expect(fixture.nativeElement.textContent).toContain('重新加载');
      finish();
      await Promise.resolve();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
