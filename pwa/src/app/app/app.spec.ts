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
import { SessionStore } from '../session/session-store';
import { App } from './app';

describe('App', () => {
  const session = { initialize: vi.fn<() => Promise<void>>(), user: signal<typeof testUser | undefined>(undefined) };

  beforeEach(async () => {
    session.initialize.mockReset().mockResolvedValue();
    session.user.set(undefined);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: PushNotifications, useValue: { start: vi.fn() } },
        provideRouter([]),
        { provide: SessionStore, useValue: session },
      ],
    }).compileComponents();
  });

  afterAll(() => vi.unstubAllGlobals());

  describe('iOS visual viewport', () => {
    const platforms = getPlatforms();
    const originalPlatforms = [...platforms];
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };

    beforeEach(() => {
      platforms.splice(0, platforms.length, 'ios');
      viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
      vi.stubGlobal('visualViewport', viewport);
      TestBed.overrideComponent(App, { set: { template: '' } });
    });

    afterEach(() => {
      TestBed.resetTestingModule();
      platforms.splice(0, platforms.length, ...originalPlatforms);
      vi.unstubAllGlobals();
    });

    it('fits keyboard opening, viewport panning and closing without scrolling the document', () => {
      const scroll = vi.spyOn(window, 'scrollTo');
      TestBed.createComponent(App);
      expect(document.body.style.height).toBe(`${window.innerHeight}px`);
      viewport.height = 420;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.style.height).toBe('420px');
      expect(document.body.style.getPropertyValue('--ion-safe-area-bottom')).toBe('0px');
      viewport.offsetTop = 80;
      viewport.dispatchEvent(new Event('scroll'));
      expect(document.body.style.top).toBe('80px');
      viewport.height = 390;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.style.height).toBe('390px');
      viewport.height = window.innerHeight;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.style.height).toBe(`${window.innerHeight}px`);
      expect(document.body.style.top).toBe('0px');
      expect(document.body.style.getPropertyValue('--ion-safe-area-bottom')).toBe('');
      expect(scroll).not.toHaveBeenCalled();
      scroll.mockRestore();
    });

    it('preserves browser pinch zoom and restores sizing when zoom ends', () => {
      TestBed.createComponent(App);
      viewport.scale = 2;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.style.height).toBe('');
      expect(document.body.style.top).toBe('');
      viewport.scale = 1;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.style.height).toBe(`${window.innerHeight}px`);
    });

    it('cleans up sizing and viewport listeners when the app is destroyed', () => {
      const fixture = TestBed.createComponent(App);
      fixture.destroy();
      viewport.height = 420;
      viewport.offsetTop = 50;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      expect(document.body.style.height).toBe('');
      expect(document.body.style.top).toBe('');
    });

    it('keeps the safe area for browser chrome and hardware keyboards', () => {
      TestBed.createComponent(App);
      viewport.height = window.innerHeight - 80;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.style.getPropertyValue('--ion-safe-area-bottom')).toBe('');
    });

    it('keeps desktop layout under browser control', () => {
      platforms.splice(0, platforms.length, 'desktop');
      TestBed.createComponent(App);
      viewport.height = 420;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.style.height).toBe('');
      expect(document.body.style.top).toBe('');
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

  it('shows a top-level teapot message without an application shell', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector(':scope > h1')?.textContent).toBe("418 I'm a teapot");
    expect(element.querySelector('ion-app, ion-header, ion-content')).toBeNull();
    expect(element.querySelector('ion-split-pane')).toBeNull();
    expect(element.querySelector('app-chat-list')).toBeNull();
    expect(TestBed.inject(PushNotifications).start).not.toHaveBeenCalled();
  });

  it('owns startup loading and clears a transient error when retrying', async () => {
    session.initialize.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('暂时无法登录，请重试。');
    let finish!: () => void;
    session.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const retry = fixture.componentInstance['initialize']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.loading-status')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('正在登录');
    expect(fixture.nativeElement.querySelector('p')).toBeNull();
    finish();
    await retry;
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain("418 I'm a teapot");
  });

  it('shows an expired authorization error when startup rejects the token', async () => {
    session.initialize.mockRejectedValueOnce(new HttpErrorResponse({ status: 401 }));
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('p').textContent).toContain('授权已失效');
    expect(fixture.nativeElement.querySelector('app-chat-list')).toBeNull();
  });
});
