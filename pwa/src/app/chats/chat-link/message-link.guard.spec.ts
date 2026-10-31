import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { NavigationSkipped, NavigationSkippedCode, provideRouter, Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer, type RpcTestRequest } from '../../api/rpc-testing';
import { wireMessage } from '../../api/testing';
import { routes } from '../../app.routes';

const link = '/m/ACAAAAAAAAEAIAAAAAAACw';
const messageParams = { chatId: '9007199254740993', messageId: '9007199254741003' };
const conversation = '/chats/chat/9007199254740993';

describe('Message permalink navigation', () => {
  let router: Router;
  let peer: RpcTestPeer;
  let toast: { present: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  let create: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    toast = { present: vi.fn().mockResolvedValue(undefined), remove: vi.fn() };
    create = vi.fn().mockResolvedValue(toast);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          routes.find((route) => route.path === 'm/:encoded')!,
          { path: 'chats', children: [] },
          { path: 'settings', children: [] },
          { path: 'chats/chat/:id', children: [] },
          { path: 'chats/chat/:id/thread/:threadId', children: [] },
        ]),
        provideLocationMocks(),
        provideRpcTesting(),
        { provide: ToastController, useValue: { create } },
      ],
    });
    router = TestBed.inject(Router);
    router.setUpLocationChangeListener();
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    await firstValueFrom(TestBed.inject(TranslocoService).load('zh-CN'));
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  async function requestLink() {
    const navigation = router.navigateByUrl(link);
    let request!: RpcTestRequest;
    await vi.waitFor(() => {
      request = peer.expect('messages.get', messageParams);
    });
    return { navigation, request };
  }

  it.each([RpcErrorCode.NotFound, RpcErrorCode.Forbidden, RpcErrorCode.Internal, 'disconnected'] as const)(
    'keeps the current URL and history on failure (%s), showing one toast',
    async (code) => {
      await router.navigateByUrl('/chats');
      await router.navigateByUrl(conversation + '#msg=123');
      const location = TestBed.inject(Location);
      const { navigation, request } = await requestLink();
      expect(router.url).toBe(conversation + '#msg=123');
      expect(location.path(true)).toBe(conversation + '#msg=123');
      if (code === 'disconnected') {
        peer.disconnect();
        request.flush(wireMessage);
      } else request.error(code);
      expect(await navigation).toBe(false);
      expect(router.url).toBe(conversation + '#msg=123');
      expect(location.path(true)).toBe(conversation + '#msg=123');
      expect(create).toHaveBeenCalledExactlyOnceWith({
        message: code === RpcErrorCode.NotFound ? '消息已撤回或不存在' : '链接无法打开',
        duration: 3000,
      });
      expect(toast.present).toHaveBeenCalledOnce();
      location.back();
      await vi.waitFor(() => expect(router.url).toBe('/chats'));
    },
  );

  it.each([undefined, '9007199254740995'])('opens a valid message in its actual scope (%s)', async (replyRootId) => {
    await router.navigateByUrl('/chats');
    const { navigation, request } = await requestLink();
    expect(router.url).toBe('/chats');
    request.flush({ ...wireMessage, replyRootId });
    expect(await navigation).toBe(true);
    expect(router.url).toBe(conversation + (replyRootId ? '/thread/' + replyRootId : '') + '#msg=9007199254741003');
    const skipped: NavigationSkipped[] = [];
    const subscription = router.events.subscribe((event) => {
      if (event instanceof NavigationSkipped) skipped.push(event);
    });
    const repeated = await requestLink();
    repeated.request.flush({ ...wireMessage, replyRootId });
    expect(await repeated.navigation).toBe(false);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].code).toBe(NavigationSkippedCode.IgnoredSameUrlNavigation);
    expect(skipped[0].url).toBe(router.url);
    subscription.unsubscribe();
    expect(create).not.toHaveBeenCalled();
    TestBed.inject(Location).back();
    await vi.waitFor(() => expect(router.url).toBe('/chats'));
  });

  it('opens the chat list with a toast when an unavailable link is the initial URL', async () => {
    const { navigation, request } = await requestLink();
    request.error(RpcErrorCode.NotFound);
    expect(await navigation).toBe(true);
    expect(router.url).toBe('/chats');
    expect(toast.present).toHaveBeenCalledOnce();
  });

  it('cancels a pending lookup when the user navigates elsewhere', async () => {
    await router.navigateByUrl(conversation);
    const { navigation, request } = await requestLink();
    await router.navigateByUrl('/settings');
    expect(await navigation).toBe(false);
    request.flush(wireMessage);
    expect(router.url).toBe('/settings');
    expect(create).not.toHaveBeenCalled();
  });

  it('discards a toast created after the user has navigated away', async () => {
    let finish!: (value: typeof toast) => void;
    create.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await router.navigateByUrl(conversation);
    const { navigation, request } = await requestLink();
    request.error(RpcErrorCode.NotFound);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await router.navigateByUrl('/settings');
    finish(toast);
    expect(await navigation).toBe(false);
    await vi.waitFor(() => expect(toast.remove).toHaveBeenCalledOnce());
    expect(toast.present).not.toHaveBeenCalled();
  });

  it('keeps malformed links on the current page with a toast', async () => {
    await router.navigateByUrl(conversation);
    expect(await router.navigateByUrl('/m/invalid')).toBe(false);
    expect(router.url).toBe(conversation);
    expect(create).toHaveBeenCalledExactlyOnceWith({ message: '链接无法打开', duration: 3000 });
    peer.expectNone('messages.get');
  });

  it('uses the active language for the unavailable-message toast', async () => {
    const i18n = TestBed.inject(TranslocoService);
    await firstValueFrom(i18n.load('en'));
    i18n.setActiveLang('en');
    await router.navigateByUrl(conversation);
    const { navigation, request } = await requestLink();
    request.error(RpcErrorCode.NotFound);
    await navigation;
    expect(create).toHaveBeenCalledExactlyOnceWith({
      message: 'This message was deleted or no longer exists',
      duration: 3000,
    });
  });
});
