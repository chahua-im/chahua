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

  it.each(['/landing', '/chats', '/chats/join/example'])(
    'shows 418 immediately without a token at %s',
    async (path) => {
      history.replaceState(null, '', path);
      session.token.set(undefined);
      try {
        const fixture = TestBed.createComponent(App);
        fixture.detectChanges();
        const element: HTMLElement = fixture.nativeElement;
        expect(element.querySelector(':scope > h1')?.textContent).toBe("418 I'm a teapot");
        expect(element.querySelector('ion-app, ion-router-outlet')).toBeNull();
        expect(session.restoreToken).toHaveBeenCalledOnce();
        expect(session.initialize).not.toHaveBeenCalled();
        expect(TestBed.inject(PushNotifications).start).not.toHaveBeenCalled();
        await fixture.whenStable();
        expect(TestBed.inject(AppUpdates).setInteractive).toHaveBeenLastCalledWith(false);
      } finally {
        history.replaceState(null, '', '/');
      }
    },
  );

  it('owns startup loading and clears a transient error when retrying', async () => {
    session.initialize.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('暂时无法登录，请重试。');
    let finish!: () => void;
    session.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const retry = fixture.componentInstance['initialize']();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        'ion-toolbar ion-buttons[slot="end"] ion-button ion-spinner.action-icon[slot="icon-only"]',
      ),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('正在登录');
    expect(fixture.nativeElement.querySelector('p')).toBeNull();
    finish();
    await retry;
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain("418 I'm a teapot");
    expect(fixture.nativeElement.querySelector('ion-spinner, p')).toBeNull();
  });

  it('shows 418 when rejected authorization clears the token', async () => {
    session.initialize.mockImplementationOnce(async () => {
      session.token.set(undefined);
      throw new HttpErrorResponse({ status: 401 });
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain("418 I'm a teapot");
    expect(fixture.nativeElement.querySelector('app-chat-list')).toBeNull();
    expect(TestBed.inject(AppUpdates).setInteractive).toHaveBeenLastCalledWith(false);
  });
});
