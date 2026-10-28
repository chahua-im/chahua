import { PanelUrlSerializer } from '../../navigation/panel-url';
import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  provideRouter,
  Router,
  UrlSerializer,
  withRouterConfig,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { IonModal, ModalController } from '@ionic/angular';
import { filter, firstValueFrom } from 'rxjs';
import { routes } from '../../app.routes';
import { PanelNavigation, panelPaths } from '../../navigation/panel-navigation';
import { ChatLink } from './chat-link';
import { ConversationNavigation, ConversationTargetKind } from '../../conversations/conversation-navigation';
import { DraftStore } from '../../conversations/draft-store';
import { encodeId } from '../../api/snowflake-id';

@Component({ template: '<div class="conversation">{{ draft }}</div>' })
class ReadingPage {
  draft = 'unfinished message';
}

// Use the real route configuration and guards, with a small reading page to isolate routing.
const testRoutes = routes.map((route) => (route.component ? { ...route, component: ReadingPage } : route));

describe('Panel route history', () => {
  let router: Router;
  let panels: PanelNavigation;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(testRoutes, withRouterConfig({ canceledNavigationResolution: 'computed' })),
        provideLocationMocks(),
        { provide: UrlSerializer, useClass: PanelUrlSerializer },
        { provide: DraftStore, useValue: {} },
        { provide: ModalController, useValue: { getTop: async () => undefined } },
      ],
    });
    router = TestBed.inject(Router);
    router.setUpLocationChangeListener();
    panels = TestBed.inject(PanelNavigation);
  });

  it('keeps the same primary page and message anchor for every panel entry', async () => {
    const harness = await RouterTestingHarness.create('/chats/chat/100#msg=200');
    const element = harness.routeNativeElement;
    const page = harness.routeDebugElement!.componentInstance as ReadingPage;
    page.draft = 'text with attachments';
    for (const path of [
      '/profile/2',
      '/settings',
      '/chats/chat/100/search',
      '/stickers/3',
      '/chats/chat/100/info',
      '/chats/chat/100/message/200/reactions',
      '/chats/join/abc',
      '/media',
    ]) {
      await harness.navigateByUrl(path);
      expect(harness.routeNativeElement).toBe(element);
      expect(harness.routeDebugElement!.componentInstance).toBe(page);
      expect(page.draft).toBe('text with attachments');
      expect(router.parseUrl(router.url).fragment).toBe('msg=200');
      expect(panels.paths().at(-1)).toBe(path);
    }
  });

  it('preserves the panel chain and restores it with Back and Forward', async () => {
    const expectHistoryNavigation = async (action: () => unknown, expectedUrl: string) => {
      const completed = firstValueFrom(
        router.events.pipe(
          filter(
            (event) =>
              event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError,
          ),
        ),
      );
      await action();
      const event = await completed;
      expect(event, event.toString()).toBeInstanceOf(NavigationEnd);
      expect(router.url).toBe(expectedUrl);
    };
    await RouterTestingHarness.create('/chats/chat/100');
    await router.navigateByUrl('/settings');
    await router.navigateByUrl('/settings/privacy');
    await router.navigateByUrl('/settings/blocked-users');
    const parent = router.url;
    await router.navigateByUrl('/profile/2');
    const child = router.url;
    expect(child).toBe('/chats/chat/100?settings=privacy/blocked-users&profile=2');
    await expectHistoryNavigation(() => panels.back(), parent);
    await expectHistoryNavigation(() => TestBed.inject(Location).forward(), child);
    await expectHistoryNavigation(() => panels.close(), '/chats/chat/100');
  });

  it('gives directly opened chat information its own chat as the background and close target', async () => {
    await RouterTestingHarness.create('/chats/chat/100/thread/200/info');
    expect(router.url.split('?')[0]).toBe('/chats/chat/100/thread/200');
    expect(panels.paths()).toEqual(['/chats/chat/100/thread/200/info']);
    expect(router.url).toBe('/chats/chat/100/thread/200?info');
    await panels.close();
    expect(router.url).toBe('/chats/chat/100/thread/200');
  });

  it.each(['', '/thread/300'])('repositions the same message after closing search over %s', async (thread) => {
    const base = '/chats/chat/100' + thread;
    const harness = await RouterTestingHarness.create(base + '#msg=200');
    const page = harness.routeDebugElement!.componentInstance;
    const navigation = TestBed.inject(ConversationNavigation);
    const positioned = vi.fn();
    const subscription = navigation.requests$.subscribe(positioned);
    try {
      await router.navigateByUrl('/chats/chat/100/search');
      expect(await navigation.open(encodeId('100'), thread ? encodeId('300') : undefined, encodeId('200'))).toBe(true);
      expect(router.url).toBe(base + '#msg=200');
      expect(harness.routeDebugElement!.componentInstance).toBe(page);
      expect(positioned).toHaveBeenCalledExactlyOnceWith({
        chatId: encodeId('100'),
        threadId: thread ? encodeId('300') : undefined,
        target: { type: ConversationTargetKind.Message, messageId: encodeId('200') },
      });
    } finally {
      subscription.unsubscribe();
    }
  });

  it('does not reposition a message when its source panel rejects exit', async () => {
    await RouterTestingHarness.create('/chats/chat/100#msg=200');
    await router.navigateByUrl('/chats/chat/100/search');
    panels.registerLeaveCheck('/chats/chat/100/search', () => false);
    const navigation = TestBed.inject(ConversationNavigation);
    const positioned = vi.spyOn(navigation, 'goTo');
    expect(await navigation.open(encodeId('100'), undefined, encodeId('200'))).toBe(false);
    expect(positioned).not.toHaveBeenCalled();
    expect(router.url).toBe('/chats/chat/100?search#msg=200');
  });

  it('clears a copied chain at the history origin without activating its intermediate panels', async () => {
    const harness = await RouterTestingHarness.create('/chats/chat/100?settings=privacy/blocked-users#msg=200');
    const page = harness.routeDebugElement!.componentInstance;
    await router.navigateByUrl('/profile/2');
    await panels.updatePage('image');
    const child = router.url;
    const destinations: string[] = [];
    const subscription = router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) destinations.push(event.urlAfterRedirects);
    });
    try {
      await panels.close();
      await vi.waitFor(() => expect(router.url).toBe('/chats/chat/100#msg=200'));
      expect(destinations).toEqual(['/chats/chat/100#msg=200']);
      expect(panels.paths()).toEqual([]);
      expect(harness.routeDebugElement!.componentInstance).toBe(page);
      TestBed.inject(Location).forward();
      await vi.waitFor(() => expect(panels.paths().at(-1)).toBe('/profile/2'));
      TestBed.inject(Location).forward();
      await vi.waitFor(() => expect(router.url).toBe(child));
    } finally {
      subscription.unsubscribe();
    }
  });

  it('checks retained copied ancestors when closing and restores history if exit is rejected', async () => {
    await RouterTestingHarness.create('/chats/chat/100?settings=privacy/friend-verification');
    await router.navigateByUrl('/profile/2');
    const current = router.url;
    const leave = vi.fn().mockResolvedValue(false);
    panels.registerLeaveCheck('/settings/friend-verification', leave);
    await panels.close();
    await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(TestBed.inject(Location).path()).toBe(current));
    expect(router.url).toBe(current);
    leave.mockResolvedValue(true);
    await panels.close();
    await vi.waitFor(() => expect(router.url).toBe('/chats/chat/100'));
  });

  it('provides semantic parents for directly opened settings without leaving the application', async () => {
    await RouterTestingHarness.create('/settings/blocked-users');
    expect(panels.paths()).toEqual(['/settings', '/settings/privacy', '/settings/blocked-users']);
    await panels.back();
    expect(panels.paths()).toEqual(['/settings', '/settings/privacy']);
    await panels.close();
    expect(router.url).toBe('/chats');
  });

  it('replaces a revoked detail view in place, including behind another panel, without resetting close depth', async () => {
    await RouterTestingHarness.create('/chats/chat/100');
    await router.navigateByUrl('/chats/chat/100/info');
    await panels.updatePage(3);
    await router.navigateByUrl('/profile/2');
    const depth = (TestBed.inject(Location).getState() as { panelDepth: number }).panelDepth;
    await panels.replacePage('/chats/chat/100/info', 0);
    expect(panels.paths()).toEqual(['/chats/chat/100/info?view=0', '/profile/2']);
    expect((TestBed.inject(Location).getState() as { panelDepth: number }).panelDepth).toBe(depth);
    await panels.close();
    await vi.waitFor(() => expect(router.url).toBe('/chats/chat/100'));
  });

  it('records detail sub-pages without adding another panel instance', async () => {
    await RouterTestingHarness.create('/chats/chat/100');
    await router.navigateByUrl('/chats/chat/100/info');
    const overview = router.url;
    await panels.updatePage('image');
    expect(router.url).toBe('/chats/chat/100?info=images');
    expect(panelPaths(router.parseUrl(router.url))).toEqual(['/chats/chat/100/info?view=image']);
    await panels.back();
    await vi.waitFor(() => expect(router.url).toBe(overview));
  });

  it('restores a copied chain and returns through each parent without requiring the original history', async () => {
    const harness = await RouterTestingHarness.create(
      '/chats/chat/100?settings=privacy/blocked-users&profile=2#msg=200',
    );
    const page = harness.routeNativeElement;
    expect(panels.paths()).toEqual(['/settings', '/settings/privacy', '/settings/blocked-users', '/profile/2']);
    for (const suffix of ['settings=privacy/blocked-users', 'settings=privacy', 'settings', '']) {
      await panels.back();
      expect(router.url).toBe('/chats/chat/100' + (suffix ? '?' + suffix : '') + '#msg=200');
      expect(harness.routeNativeElement).toBe(page);
    }
  });

  it('normalizes old panel links and preserves skipped settings ancestors on a copied URL', async () => {
    await RouterTestingHarness.create('/chats/chat/100?panel=%2Fprofile%2F2&panel=%2Fsettings%2Fprivacy');
    expect(router.url).toBe('/chats/chat/100?profile=2&settings=~privacy');
    expect(panels.paths()).toEqual(['/profile/2', '/settings/privacy']);
    await panels.back();
    expect(router.url).toBe('/chats/chat/100?profile=2');
  });

  it('restores a copied detail sub-page and returns to its overview in place', async () => {
    const harness = await RouterTestingHarness.create('/chats/chat/100?info=files');
    const page = harness.routeNativeElement;
    expect(panels.paths()).toEqual(['/chats/chat/100/info?view=other']);
    await panels.back();
    expect(router.url).toBe('/chats/chat/100?info');
    expect(harness.routeNativeElement).toBe(page);
  });

  it('retains the form and URL when an exit guard rejects navigation or browser Back', async () => {
    await RouterTestingHarness.create('/chats/chat/100');
    await router.navigateByUrl('/settings/friend-verification');
    const current = router.url;
    const leave = vi.fn().mockResolvedValue(false);
    panels.registerLeaveCheck('/settings/friend-verification', leave);
    expect(await router.navigateByUrl('/chats/chat/200')).toBe(false);
    expect(router.url).toBe(current);
    await panels.back();
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(2));
    expect(router.url).toBe(current);
    leave.mockResolvedValue(true);
    expect(await router.navigateByUrl('/chats/chat/200')).toBe(true);
    expect(panels.paths()).toEqual([]);
  });

  it('checks the replaced profile, moves the new profile to the top, and preserves Back and Forward', async () => {
    const harness = await RouterTestingHarness.create('/chats/chat/100?profile=2&settings=privacy');
    const page = harness.routeNativeElement;
    const previous = router.url;
    const leave = vi.fn().mockResolvedValue(false);
    panels.registerLeaveCheck('/profile/2', leave);
    expect(await router.navigateByUrl('/profile/3')).toBe(false);
    expect(router.url).toBe(previous);
    expect(harness.routeNativeElement).toBe(page);
    expect(leave).toHaveBeenCalledOnce();
    leave.mockResolvedValue(true);
    expect(await router.navigateByUrl('/profile/3')).toBe(true);
    const replacement = '/chats/chat/100?settings=privacy&profile=3';
    expect(router.url).toBe(replacement);
    expect(panels.paths()).toEqual(['/settings', '/settings/privacy', '/profile/3']);
    TestBed.inject(Location).back();
    await vi.waitFor(() => expect(router.url).toBe(previous));
    TestBed.inject(Location).forward();
    await vi.waitFor(() => expect(router.url).toBe(replacement));
  });

  it('guards a covered settings form even when the visible profile remains unchanged', async () => {
    await RouterTestingHarness.create('/chats/chat/100?settings=privacy/friend-verification&profile=2');
    const previous = router.url;
    const leave = vi.fn().mockResolvedValue(false);
    panels.registerLeaveCheck('/settings/friend-verification', leave);
    expect(await router.navigateByUrl('/chats/chat/100?profile=2')).toBe(false);
    expect(router.url).toBe(previous);
    expect(await router.navigateByUrl('/settings/general')).toBe(false);
    expect(router.url).toBe(previous);
    expect(leave).toHaveBeenCalledTimes(2);
    leave.mockResolvedValue(true);
    expect(await router.navigateByUrl('/settings/general')).toBe(true);
    expect(router.url).toBe('/chats/chat/100?profile=2&settings=general');
  });

  it('updates the visible layer when only query parameter order changes', async () => {
    await RouterTestingHarness.create('/chats/chat/100?settings=privacy&profile=2');
    expect(panels.paths().at(-1)).toBe('/profile/2');
    expect(await router.navigateByUrl('/chats/chat/100?profile=2&settings=privacy')).toBe(true);
    expect(panels.paths().at(-1)).toBe('/settings/privacy');
  });

  it('keeps media payload in history state and closes just the viewer', async () => {
    await RouterTestingHarness.create('/chats/chat/100');
    await router.navigateByUrl('/chats/chat/100/info');
    const parent = router.url;
    const media = [{ url: 'signed-private-url' }];
    await router.navigate(['/media'], { state: { media, initial: 0 } });
    expect((TestBed.inject(Location).getState() as { media: unknown }).media).toEqual(media);
    expect(router.url).not.toContain('signed-private-url');
    await panels.close();
    await vi.waitFor(() => expect(router.url).toBe(parent));
  });

  it('closes a local picker on browser Back without leaving its parent page', async () => {
    await RouterTestingHarness.create('/chats');
    await router.navigateByUrl('/chats/chat/100');
    const picker = document.createElement('ion-modal');
    picker.dismiss = vi.fn().mockResolvedValue(true);
    document.body.append(picker);
    await new Promise((resolve) => setTimeout(resolve, 0));
    picker.classList.remove('overlay-hidden');
    picker.overlayIndex = 1;
    try {
      TestBed.inject(Location).back();
      await vi.waitFor(() => expect(picker.dismiss).toHaveBeenCalledWith(undefined, 'back'));
      expect(router.url).toBe('/chats/chat/100');
    } finally {
      picker.remove();
    }
  });
});

@Component({ selector: 'test-modal', template: '', providers: [{ provide: IonModal, useExisting: ModalStub }] })
class ModalStub {
  visible = false;
  finishOpening!: () => void;
  async present() {
    await new Promise<void>((resolve) => (this.finishOpening = resolve));
    this.visible = true;
  }
  async dismiss() {
    this.visible = false;
  }
}

describe('Panel presentation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finishes closing when Back arrives during the opening animation', async () => {
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    const paths = signal(['/profile/2']);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PanelNavigation,
          useValue: { paths, sidebar: () => false, media: () => false, largeScreen: signal(false) },
        },
      ],
    }).overrideComponent(ChatLink, { set: { imports: [ModalStub], template: '<test-modal />' } });
    const fixture = TestBed.createComponent(ChatLink);
    fixture.detectChanges();
    await Promise.resolve();
    const modal = fixture.debugElement.children[0].componentInstance as ModalStub;
    paths.set([]);
    fixture.detectChanges();
    modal.finishOpening();
    await fixture.componentInstance['transition'];
    expect(modal.visible).toBe(false);
  });
});
