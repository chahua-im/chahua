import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { routes } from './app.routes';
import { listSelection, ListTab } from './chats/list-tabs';

describe('App routes', () => {
  let router: Router;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    router = TestBed.inject(Router);
  });

  it('redirects the root and unknown tabs to the chat list', async () => {
    await router.navigateByUrl('/');
    expect(router.url).toBe('/chats');
    expect(listSelection(router.routerState.snapshot.root)?.tab).toBe(ListTab.Messages);
    await router.navigateByUrl('/chats/unknown');
    expect(router.url).toBe('/chats');
  });

  it('recognizes all four list tabs', async () => {
    for (const tab of ['messages', 'groups', 'friends', 'threads']) {
      await router.navigateByUrl(`/chats/${tab}`);
      expect(router.url).toBe(`/chats/${tab}`);
      expect(listSelection(router.routerState.snapshot.root)).toEqual({ tab, archived: false, requestHistory: false });
    }
  });

  it('matches category archives, friend request history and topic links', async () => {
    for (const tab of ['messages', 'groups', 'friends', 'threads']) {
      await router.navigateByUrl(`/chats/${tab}/archived`);
      expect(router.routerState.snapshot.root.firstChild?.data['archived']).toBe(true);
    }
    await router.navigateByUrl('/chats/friends/archived-requests');
    expect(router.routerState.snapshot.root.firstChild?.data['requestHistory']).toBe(true);
    await router.navigateByUrl('/chats/chat/9007199254740993/thread/9007199254740995');
    expect(router.routerState.snapshot.root.firstChild?.params['threadId']).toBe('9007199254740995');
    await router.navigateByUrl('/chats/unknown/archived');
    expect(router.url).toBe('/chats');
  });

  it('recognizes a conversation separately from a list tab and preserves its string ID', async () => {
    await router.navigateByUrl('/chats/chat/9007199254740993');
    const route = router.routerState.snapshot.root.firstChild;
    expect(route?.routeConfig?.path).toBe('chats/chat/:id');
    expect(route?.params['id']).toBe('9007199254740993');
  });

  it('matches saved and scoped pin collections before the generic list routes', async () => {
    await router.navigateByUrl('/chats/saved');
    expect(router.routerState.snapshot.root.firstChild?.component?.name).toContain('SavedMessagesPage');
    await router.navigateByUrl('/chats/chat/9007199254740993/pins');
    expect(router.routerState.snapshot.root.firstChild?.component?.name).toContain('PinnedMessagesPage');
    expect(router.routerState.snapshot.root.firstChild?.params['id']).toBe('9007199254740993');
    await router.navigateByUrl('/chats/chat/9007199254740993/thread/100/pins');
    expect(router.routerState.snapshot.root.firstChild?.component?.name).toContain('PinnedMessagesPage');
    expect(router.routerState.snapshot.root.firstChild?.params['threadId']).toBe('100');
  });
});
