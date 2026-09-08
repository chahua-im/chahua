import { DestroyRef, effect, inject, Injector, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { ModalController } from '@ionic/angular';
import { filter, firstValueFrom, timeout } from 'rxjs';
import { PushService } from '../../generated/endpoints/push/push.service';
import {
  ApiPushProvider,
  GroupKind,
  MessageType,
  ServerWsMessageType,
  type MessageResponse,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { decodeId, encodeId, type SnowflakeID } from '../api/snowflake-id';
import { ChatListStore } from '../chats/chat-list-store';
import { ChatStore } from '../chats/chat-store';
import { dismissChatOverlays } from '../chats/dismiss-chat-overlays';
import { ConversationNavigation, ConversationTargetKind } from '../conversations/conversation-navigation';
import { SessionStore } from '../session/session-store';
import { notificationText, shouldNotify } from './notification-policy';

const ENABLED_KEY = 'chahua.notifications.enabled';

export enum PushNotificationError {
  UnsupportedBrowser = 'unsupported_browser',
  PermissionDenied = 'permission_denied',
  ServiceWorkerUnavailable = 'service_worker_unavailable',
  SubscribeFailed = 'subscribe_failed',
  BackendSubscribeFailed = 'backend_subscribe_failed',
  UnsubscribeFailed = 'unsubscribe_failed',
  RefreshFailed = 'refresh_failed',
}

@Service()
export class PushNotifications {
  private readonly push = inject(SwPush);
  private readonly api = inject(PushService);
  private readonly permissionState = signal<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'default',
  );
  private readonly subscriptionState = signal(false);
  private readonly enabledState = signal(window.localStorage.getItem(ENABLED_KEY) === 'true');
  readonly enabled = this.enabledState.asReadonly();
  private readonly working = signal(false);
  private readonly failure = signal<PushNotificationError | undefined>(undefined);
  readonly permission = this.permissionState.asReadonly();
  readonly subscribed = this.subscriptionState.asReadonly();
  readonly busy = this.working.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly supported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;

  private readonly destroy = inject(DestroyRef);
  private readonly connection = inject(Connection);
  private readonly chats = inject(ChatStore);
  private readonly lists = inject(ChatListStore);
  private readonly injector = inject(Injector);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly navigation = inject(ConversationNavigation);
  private readonly seen = new Set<SnowflakeID>();
  private readonly currentBanner = signal<MessageResponse | undefined>(undefined);
  readonly banner = this.currentBanner.asReadonly();
  private bannerTimer?: ReturnType<typeof setTimeout>;
  private started = false;
  private incomingVersion = 0;
  private shownVersion = 0;

  start() {
    if (this.started) return;
    this.started = true;
    const baseTitle = document.title;
    const hidden = signal(document.hidden);
    const visibility = () => hidden.set(document.hidden);
    document.addEventListener('visibilitychange', visibility);
    this.destroy.onDestroy(() => {
      document.removeEventListener('visibilitychange', visibility);
      document.title = baseTitle;
    });
    effect(
      (onCleanup) => {
        if ('setAppBadge' in navigator || hidden()) onCleanup(this.lists.unread.activate());
      },
      { injector: this.injector },
    );
    effect(
      () => {
        const count = this.lists.unread.value()?.unreadCount ?? 0;
        document.title = hidden() && this.session.user() && count ? `(${count}) ${baseTitle}` : baseTitle;
      },
      { injector: this.injector },
    );
    if ('setAppBadge' in navigator) {
      effect(
        () => {
          const counts = this.lists.unread.value();
          if (!counts || !this.session.user()) return;
          const badges = navigator as Navigator & {
            setAppBadge(count: number): Promise<void>;
            clearAppBadge(): Promise<void>;
          };
          void (counts.unreadCount ? badges.setAppBadge(counts.unreadCount) : badges.clearAppBadge()).catch(() => {});
        },
        { injector: this.injector },
      );
    }
    this.connection.resync$.pipe(takeUntilDestroyed(this.destroy)).subscribe(() => {
      if (!this.session.user()) return;
      void this.refresh();
    });
    this.connection.events$.pipe(takeUntilDestroyed(this.destroy)).subscribe((event) => {
      if (!this.session.user()) return;
      switch (event.type) {
        case ServerWsMessageType.message:
          void this.notify(event.payload, ++this.incomingVersion).catch(() => {});
          break;
        case ServerWsMessageType.messageDeleted:
          this.closeMessages([event.payload.id]);
          break;
        case ServerWsMessageType.messagesBulkDeleted:
          this.closeMessages(event.payload.messageIds);
          break;
      }
    });
    this.chats.changes$.pipe(takeUntilDestroyed(this.destroy)).subscribe(({ chatId, threadId, readThrough }) => {
      if (!readThrough) return;
      const banner = this.banner();
      if (banner?.chatId === chatId && banner.replyRootId == threadId && banner.id <= readThrough) this.dismiss();
      void this.workerCommand({
        type: 'CHAHUA_CLOSE',
        chatId: decodeId(chatId),
        threadRootId: threadId ? decodeId(threadId) : undefined,
        readThrough: decodeId(readThrough),
      });
    });
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe(() => {
        const banner = this.banner();
        if (banner && this.currentConversation(banner)) this.dismiss();
      });
    this.push.notificationClicks.pipe(takeUntilDestroyed(this.destroy)).subscribe(({ notification }) => {
      if (document.hidden) return;
      const data = notification.data;
      const valid = (id: unknown): id is string => typeof id === 'string' && /^\d+$/.test(id);
      if (!valid(data?.chatId) || !valid(data?.messageId)) return;
      void this.open(
        encodeId(data.chatId),
        encodeId(data.messageId),
        valid(data.threadRootId) ? encodeId(data.threadRootId) : undefined,
      );
    });
    this.destroy.onDestroy(() => clearTimeout(this.bannerTimer));
    void this.refresh();
  }

  dismiss() {
    clearTimeout(this.bannerTimer);
    this.currentBanner.set(undefined);
  }

  async open(chatId: SnowflakeID, messageId: SnowflakeID, threadId?: SnowflakeID) {
    this.dismiss();
    await dismissChatOverlays(this.modals);
    const path = ['/chats/chat', decodeId(chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])];
    await this.router.navigate(path, { queryParams: { message: decodeId(messageId) } });
    this.navigation.goTo(chatId, { type: ConversationTargetKind.Message, messageId }, threadId);
  }

  private currentConversation(message: MessageResponse) {
    const url = this.router.parseUrl(this.router.url);
    const path = url.root.children['primary']?.segments.map((segment) => segment.path).join('/');
    const target =
      `chats/chat/${decodeId(message.chatId)}` +
      (message.replyRootId ? `/thread/${decodeId(message.replyRootId)}` : '');
    return path === target && url.queryParams['settings'] !== '1';
  }

  private async notify(message: MessageResponse, version: number) {
    const uid = this.session.user()?.uid;
    if (
      !uid ||
      message.sender.uid === uid ||
      message.isDeleted ||
      message.messageType === MessageType.system ||
      this.seen.has(message.id) ||
      window.localStorage.getItem(ENABLED_KEY) === 'false'
    )
      return;
    await this.chats.ensureDetails(message.chatId).catch(() => {});
    if (message.replyRootId) await this.chats.loadSubscription(message.chatId, message.replyRootId).catch(() => {});
    if (
      this.session.user()?.uid !== uid ||
      this.seen.has(message.id) ||
      window.localStorage.getItem(ENABLED_KEY) === 'false'
    )
      return;
    const chat = this.chats.get(message.chatId);
    const state = this.chats.chatState(message.chatId) ?? chat;
    const thread = message.replyRootId ? this.chats.subscription(message.chatId, message.replyRootId) : undefined;
    if (!shouldNotify(message, uid, state, thread)) return;
    const foreground = !document.hidden;
    if (!foreground && (!this.enabled() || this.permission() !== 'granted')) return;
    const title =
      (chat?.kind === GroupKind.dm ? chat.peer?.username : chat?.name) ??
      message.sender.name ??
      String(message.sender.uid);
    const text = notificationText(message);
    this.remember(message.id);
    const accepted = await this.workerCommand({
      type: 'CHAHUA_NOTIFY',
      foreground,
      payload: {
        type: 'newMessage',
        title,
        body: chat?.kind === GroupKind.dm ? text : `${message.sender.name ?? message.sender.uid}: ${text}`,
        data: {
          chatId: decodeId(message.chatId),
          messageId: decodeId(message.id),
          threadRootId: message.replyRootId ? decodeId(message.replyRootId) : undefined,
        },
      },
    });
    if (
      !accepted ||
      !foreground ||
      document.hidden ||
      this.destroy.destroyed ||
      this.session.user()?.uid !== uid ||
      window.localStorage.getItem(ENABLED_KEY) === 'false' ||
      (this.currentConversation(message) && !(await this.modals.getTop())) ||
      version < this.shownVersion
    )
      return;
    this.shownVersion = version;
    this.dismiss();
    this.currentBanner.set(message);
    this.bannerTimer = setTimeout(() => this.dismiss(), 5000);
  }

  private remember(id: SnowflakeID) {
    this.seen.add(id);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
  }

  private closeMessages(ids: readonly SnowflakeID[]) {
    for (const id of ids) this.remember(id);
    if (this.banner() && ids.includes(this.banner()!.id)) this.dismiss();
    void this.workerCommand({ type: 'CHAHUA_CLOSE', messageIds: ids.map(decodeId) });
  }

  private async workerCommand(data: object): Promise<boolean> {
    if (!this.push.isEnabled || !('serviceWorker' in navigator)) return true;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration?.active) return true;
      return await new Promise<boolean>((resolve) => {
        const channel = new MessageChannel();
        const finish = (accepted: boolean) => {
          clearTimeout(timer);
          channel.port1.close();
          resolve(accepted);
        };
        const timer = setTimeout(() => finish(true), 1500);
        channel.port1.onmessage = (event) => finish(event.data === true);
        registration.active!.postMessage(data, [channel.port2]);
      });
    } catch {
      return true;
    }
  }

  async refresh(): Promise<void> {
    if (this.busy()) return;
    this.failure.set(undefined);
    if (!this.canUsePush()) return;
    this.working.set(true);
    this.permissionState.set(Notification.permission);
    try {
      const subscription = await this.currentSubscription();
      const status = subscription
        ? await firstValueFrom(this.api.getSubscriptionStatus({ endpoint: subscription.endpoint }, { timeout: 10000 }))
        : undefined;
      if (window.localStorage.getItem(ENABLED_KEY) !== 'false') {
        this.subscriptionState.set(Notification.permission === 'granted' && status?.hasMatchingEndpoint === true);
        if (this.subscribed()) this.setDeviceEnabled(true);
      }
    } catch (error) {
      this.failure.set(
        error === PushNotificationError.ServiceWorkerUnavailable ? error : PushNotificationError.RefreshFailed,
      );
    } finally {
      this.working.set(false);
    }
  }

  // Call directly from the toggle event so permission is requested within the user gesture.
  async setEnabled(enabled: boolean): Promise<boolean> {
    if (this.busy()) return false;
    this.failure.set(undefined);
    if (!this.canUsePush()) return false;
    this.working.set(true);
    try {
      if (enabled) {
        const permission =
          Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        this.permissionState.set(permission);
        if (permission !== 'granted') throw PushNotificationError.PermissionDenied;
        this.setDeviceEnabled(true);
        await this.subscribe();
      } else {
        await this.unsubscribe();
      }
      this.subscriptionState.set(enabled);
      this.setDeviceEnabled(enabled);
      if (!enabled) {
        this.dismiss();
        void this.workerCommand({ type: 'CHAHUA_CLOSE', all: true });
      }
      return true;
    } catch (error) {
      this.failure.set(
        Object.values(PushNotificationError).includes(error as PushNotificationError)
          ? (error as PushNotificationError)
          : enabled
            ? PushNotificationError.SubscribeFailed
            : PushNotificationError.UnsubscribeFailed,
      );
      return false;
    } finally {
      this.working.set(false);
    }
  }

  private setDeviceEnabled(enabled: boolean) {
    this.enabledState.set(enabled);
    window.localStorage.setItem(ENABLED_KEY, String(enabled));
  }

  private canUsePush(): boolean {
    if (!this.supported) this.failure.set(PushNotificationError.UnsupportedBrowser);
    else if (!this.push.isEnabled) this.failure.set(PushNotificationError.ServiceWorkerUnavailable);
    else return true;
    return false;
  }

  private async currentSubscription(): Promise<PushSubscription | null> {
    try {
      return await firstValueFrom(this.push.subscription.pipe(timeout({ first: 10000 })));
    } catch {
      throw PushNotificationError.ServiceWorkerUnavailable;
    }
  }

  private async subscribe(): Promise<void> {
    let subscription = await this.currentSubscription();
    const existing = subscription !== null;
    if (!subscription) {
      const { publicKey } = await firstValueFrom(this.api.getVapidPublicKey({ timeout: 10000 }));
      subscription = await this.push.requestSubscription({ serverPublicKey: publicKey });
    }
    const keys = subscription.toJSON().keys!;
    try {
      await firstValueFrom(
        this.api.postSubscribe(
          {
            provider: ApiPushProvider.webPush,
            endpoint: subscription.endpoint,
            keys: { p256dh: keys['p256dh'], auth: keys['auth'] },
          },
          { timeout: 10000 },
        ),
      );
    } catch {
      // A new browser endpoint is only useful after the authenticated backend accepts it.
      if (!existing) await this.push.unsubscribe().catch(() => undefined);
      throw PushNotificationError.BackendSubscribeFailed;
    }
  }

  private async unsubscribe(): Promise<void> {
    const subscription = await this.currentSubscription();
    if (!subscription) return;
    await firstValueFrom(
      this.api.postUnsubscribe(
        {
          provider: ApiPushProvider.webPush,
          endpoint: subscription.endpoint,
        },
        { timeout: 10000 },
      ),
    );
    // Backend deletion already stops delivery, even if the browser cannot remove its endpoint.
    this.subscriptionState.set(false);
    this.setDeviceEnabled(false);
    this.dismiss();
    void this.workerCommand({ type: 'CHAHUA_CLOSE', all: true });
    await this.push.unsubscribe();
  }
}
