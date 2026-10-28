import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, reflectComponentType, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { testMessage } from '../api/testing';
import { ChatDetails } from '../chats/chat-details/chat-details';
import { ConversationPage } from '../conversations/conversation/conversation.page';
import { GroupKind } from '../../generated/models';
import { StartChat, StartChatKind } from '../chats/start-chat/start-chat';
import { StickerPicker } from '../messages/sticker-picker/sticker-picker';
import { NotificationCategoryPage } from '../settings/notification-settings/notification-category-page';
import { StickerPackDetail } from '../settings/sticker-pack-detail/sticker-pack-detail';
import { panelComponents } from '../panel-routes';
import { matchPanel, panelDefinitions, panelInputs } from './panel-definitions';
import { PanelPage } from './panel-page';
import { PrivacySettings } from '../settings/privacy-settings/privacy-settings';

@Component({ template: '<div>Retained page</div>' })
class ResumablePage {
  panelResume = vi.fn();
}

describe('Panel preloading', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
      ],
    });
    TestBed.overrideComponent(PanelPage, { set: { template: '' } });
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it.each(panelDefinitions)('binds only supported component inputs for $path', (definition) => {
    const path = definition.path.replace(/:\w+/g, '9007199254740993');
    const matched = matchPanel(path.split('/'))!;
    const inputs = { ...matched.definition.props, ...panelInputs(matched.definition, matched.params) };
    const supported = reflectComponentType(panelComponents[definition.content])!.inputs.map(
      (input) => input.templateName,
    );
    expect(Object.keys(inputs).every((key) => supported.includes(key))).toBe(true);
  });

  it.each([
    { path: '/chats/new', component: StartChat, props: { kind: StartChatKind.Create } },
    { path: '/chats/add-friend', component: StartChat, props: { kind: StartChatKind.Friend } },
    { path: '/chats/join', component: StartChat, props: { kind: StartChatKind.Join } },
    { path: '/chats/join/a%2Fb%26c', component: StartChat, props: { kind: StartChatKind.Join, code: 'a/b&c' } },
    { path: '/settings/notifications/dm', component: NotificationCategoryPage, props: { kind: GroupKind.dm } },
    { path: '/settings/notifications/group', component: NotificationCategoryPage, props: { kind: GroupKind.group } },
    {
      path: '/settings/stickers/9007199254740993',
      component: StickerPackDetail,
      props: { packId: encodeId('9007199254740993') },
    },
    {
      path: '/stickers/9007199254740993',
      component: StickerPicker,
      props: { packId: encodeId('9007199254740993'), selectable: false },
    },
    {
      path: '/chats/chat/100/stickers/9007199254740993',
      component: StickerPicker,
      props: { packId: encodeId('9007199254740993'), selectable: false },
    },
    {
      path: '/sticker/9007199254740993',
      component: StickerPicker,
      props: { stickerId: encodeId('9007199254740993'), selectable: false },
    },
  ])('loads $path with its declared component and typed inputs', ({ path, component, props }) => {
    const fixture = TestBed.createComponent(PanelPage);
    fixture.componentRef.setInput('path', path);
    fixture.detectChanges();
    expect(fixture.componentInstance['content']()).toEqual({ component, props });
    expect(fixture.componentInstance['failed']()).toBe(false);
    TestBed.inject(HttpTestingController).expectNone(() => true);
  });

  it.each(['known', 'missing', 'other-thread', 'other-chat'] as const)(
    'uses the source thread root only for its own scope (%s)',
    async (scope) => {
      const fixture = TestBed.createComponent(PanelPage);
      const source = Object.assign(Object.create(ConversationPage.prototype), {
        detailsContext: signal({
          chatId: scope === 'other-chat' ? encodeId('999') : testMessage.chatId,
          threadId: scope === 'other-thread' ? encodeId('999') : testMessage.id,
          threadRoot: scope === 'missing' ? undefined : testMessage,
        }),
      });
      fixture.componentRef.setInput(
        'path',
        `/chats/chat/${decodeId(testMessage.chatId)}/thread/${decodeId(testMessage.id)}/info`,
      );
      fixture.componentRef.setInput('source', source);
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      const fetchedRoot = { ...testMessage, message: 'Fetched root' };
      if (scope === 'known') {
        http.expectNone(() => true);
        expect(fixture.componentInstance['content']()).toBeDefined();
      } else {
        expect(fixture.componentInstance['content']()).toBeUndefined();
        http
          .expectOne(`/_api/chats/${decodeId(testMessage.chatId)}/messages/${decodeId(testMessage.id)}`)
          .flush({ ...fetchedRoot, id: decodeId(testMessage.id), chatId: decodeId(testMessage.chatId) });
        await fixture.whenStable();
      }
      const inputs = fixture.componentInstance['inputs']();
      expect(inputs['threadRoot']).toEqual(scope === 'known' ? testMessage : fetchedRoot);
      const supported = reflectComponentType(ChatDetails)!.inputs.map((input) => input.templateName);
      expect(Object.keys(inputs).every((key) => supported.includes(key))).toBe(true);
      if (scope === 'known') {
        const updatedRoot = { ...testMessage, message: 'Updated while open' };
        source.detailsContext.set({ ...source.detailsContext(), threadRoot: updatedRoot });
        expect(fixture.componentInstance['inputs']()['threadRoot']).toBe(updatedRoot);
        http.expectNone(() => true);
      }
    },
  );

  it('cancels the profile lookup when its panel is removed before loading finishes', async () => {
    const fixture = TestBed.createComponent(PanelPage);
    fixture.componentRef.setInput('path', '/profile/2');
    fixture.detectChanges();
    const request = TestBed.inject(HttpTestingController).expectOne('/_api/users/search?q=2&limit=20');
    fixture.destroy();
    expect(request.cancelled).toBe(true);
    await Promise.resolve();
    expect(fixture.componentInstance['content']()).toBeUndefined();
  });

  it('keeps a failed lookup in the same panel and can retry it', async () => {
    const fixture = TestBed.createComponent(PanelPage);
    fixture.componentRef.setInput('path', '/profile/2');
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/_api/users/search?q=2&limit=20').flush({}, { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();
    expect(fixture.componentInstance['failed']()).toBe(true);
    const retry = fixture.componentInstance['load']();
    http.expectOne('/_api/users/search?q=2&limit=20').flush({ members: [{ uid: 2, username: 'Alice', gender: 0 }] });
    await retry;
    expect(fixture.componentInstance['failed']()).toBe(false);
    expect(fixture.componentInstance['content']()?.props['user']).toMatchObject({ uid: 2, username: 'Alice' });
  });
});

describe('Retained panel activation', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideChahuaBaseUrl('/_api')],
    });
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it.each([true, false])('refreshes only previously hidden instances (initially active: %s)', async (active) => {
    const fixture = TestBed.createComponent(PanelPage);
    fixture.componentRef.setInput('path', '/settings');
    fixture.componentRef.setInput('active', active);
    fixture.componentInstance['content'].set({ component: ResumablePage, props: {} });
    fixture.detectChanges();
    await fixture.whenStable();
    const page = fixture.componentInstance['outlet']()!.componentInstance as ResumablePage;
    expect(page.panelResume).not.toHaveBeenCalled();
    if (active) {
      fixture.componentRef.setInput('active', false);
      fixture.detectChanges();
    }
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(page.panelResume).toHaveBeenCalledOnce();
    fixture.detectChanges();
    expect(page.panelResume).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['outlet']()!.componentInstance).toBe(page);
  });

  it('refreshes a copied privacy parent on first display while preserving known summary DOM', async () => {
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PanelPage);
    fixture.componentRef.setInput('path', '/settings/privacy');
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    const flush = (visibility: string, exceptionCount: number) => {
      http.expectOne('/_api/blocks').flush({ blocks: [] });
      http.expectOne('/_api/friends/me/settings').flush({ mode: 'direct' });
      http.expectOne('/_api/me/presence-settings').flush({ visibility, exceptionCount });
      http.expectOne('/_api/me/read-receipt-settings').flush({ visibility: 'friends', exceptionCount: 0 });
    };
    flush('everyone', 0);
    await fixture.whenStable();
    fixture.detectChanges();
    const page = fixture.componentInstance['outlet']()!.componentInstance as PrivacySettings;
    const summary = fixture.nativeElement.querySelector('ion-item[href="/settings/presence"] ion-note') as HTMLElement;
    expect(summary.textContent).toContain('所有人');
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-item[href="/settings/presence"] ion-note')).toBe(summary);
    expect(summary.textContent).toContain('所有人');
    flush('nobody', 2);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['outlet']()!.componentInstance).toBe(page);
    expect(summary.textContent).toContain('不允许任何人');
    expect(summary.textContent).toContain('2 个例外');
  });
});
