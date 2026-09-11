import { DestroyRef, effect, inject, Injector, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { ModalController } from '@ionic/angular';
import { firstValueFrom, timeout } from 'rxjs';
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
import { ConversationNavigation } from '../conversations/conversation-navigation';
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
}

@Service()
export class PushNotifications {
  private readonly push = inject(SwPush);
  private readonly api = inject(PushService);
  private readonly permissionState = signal<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'default',
  );
  private readonly enabledState = signal(window.localStorage.getItem(ENABLED_KEY) === 'true');
  readonly enabled = this.enabledState.asReadonly();
  private readonly working = signal(false);
  private readonly failure = signal<PushNotificationError | undefined>(undefined);
  readonly permission = this.permissionState.asReadonly();
  readonly busy = this.working.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly supported =
    'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator && this.push.isEnabled;
  private syncing: Promise<void> = Promise.resolve();

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
  private started = false;

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
          void this.notify(event.payload).catch(() => {});
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
      void this.workerCommand({
        type: 'CHAHUA_CLOSE',
        chatId: decodeId(chatId),
        threadRootId: threadId ? decodeId(threadId) : undefined,
        readThrough: decodeId(readThrough),
      });
    });
    this.push.notificationClicks.pipe(takeUntilDestroyed(this.destroy)).subscribe(({ notification }) => {
      if (document.hidden) return;
      const data = notification.data;
      const valid = (id: unknown): id is string => typeof id === 'string' && /^\d+$/.test(id);
      if (!valid(data?.chatId) || !valid(data?.messageId)) return;
      void this.navigation.open(
        encodeId(data.chatId),
        valid(data.threadRootId) ? encodeId(data.threadRootId) : undefined,
        encodeId(data.messageId),
      );
    });
    void this.refresh();
  }

  private currentConversation(message: MessageResponse) {
    const url = this.router.parseUrl(this.router.url);
    const path = url.root.children['primary']?.segments.map((segment) => segment.path).join('/');
    const target =
      `chats/chat/${decodeId(message.chatId)}` +
      (message.replyRootId ? `/thread/${decodeId(message.replyRootId)}` : '');
    return path === target && url.queryParams['settings'] !== '1';
  }

  private async notify(message: MessageResponse) {
    const uid = this.session.user()?.uid;
    if (
      !uid ||
      message.sender.uid === uid ||
      message.isDeleted ||
      message.messageType === MessageType.system ||
      this.seen.has(message.id) ||
      window.localStorage.getItem(ENABLED_KEY) === 'false' ||
      !this.enabled() ||
      this.permission() !== 'granted'
    )
      return;
    await this.chats.ensureDetails(message.chatId).catch(() => {});
    if (message.replyRootId) await this.chats.loadSubscription(message.chatId, message.replyRootId).catch(() => {});
    const modal = await this.modals.getTop();
    if (
      this.destroy.destroyed ||
      this.session.user()?.uid !== uid ||
      this.seen.has(message.id) ||
      window.localStorage.getItem(ENABLED_KEY) === 'false' ||
      !this.enabled() ||
      this.permission() !== 'granted'
    )
      return;
    const chat = this.chats.get(message.chatId);
    const state = this.chats.chatState(message.chatId) ?? chat;
    const thread = message.replyRootId ? this.chats.subscription(message.chatId, message.replyRootId) : undefined;
    if (!shouldNotify(message, uid, state, thread)) return;
    const title =
      (chat?.kind === GroupKind.dm ? chat.peer?.username : chat?.name) ??
      message.sender.name ??
      String(message.sender.uid);
    const text = notificationText(message);
    this.remember(message.id);
    await this.workerCommand({
      type: 'CHAHUA_NOTIFY',
      suppress: !document.hidden && this.currentConversation(message) && !modal,
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
  }

  private remember(id: SnowflakeID) {
    this.seen.add(id);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
  }

  private closeMessages(ids: readonly SnowflakeID[]) {
    for (const id of ids) this.remember(id);
    void this.workerCommand({ type: 'CHAHUA_CLOSE', messageIds: ids.map(decodeId) });
  }

  private async workerCommand(data: object): Promise<void> {
    if (!this.push.isEnabled || !('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      registration?.active?.postMessage(data);
    } catch {}
  }

  async refresh(): Promise<void> {
    if (this.busy() || !this.supported) return;
    this.failure.set(undefined);
    this.permissionState.set(Notification.permission);
    const preference = window.localStorage.getItem(ENABLED_KEY);
    if (preference === null) return;
    this.enabledState.set(preference === 'true');
    if (this.enabled() && this.permission() !== 'granted') this.setDeviceEnabled(false);
    try {
      await this.synchronize();
    } catch {
      // A network failure does not change the user's choice. Retry on the next refresh.
      this.checkPermission();
    }
  }

  shouldPrompt(): boolean {
    return this.supported && window.localStorage.getItem(ENABLED_KEY) === null;
  }

  declinePermission(): void {
    this.setDeviceEnabled(false);
    void this.refresh();
  }

  // Run in the avatar's click handler, before routing can lose user activation.
  requestSettingsPermission(): void {
    if (
      this.supported &&
      window.localStorage.getItem(ENABLED_KEY) === 'true' &&
      Notification.permission === 'default'
    ) {
      void this.setEnabled(true);
    }
  }

  // Call directly from a button or toggle event to retain the browser's user gesture.
  async setEnabled(enabled: boolean): Promise<boolean> {
    if (this.busy()) return false;
    this.failure.set(undefined);
    if (!this.supported) {
      this.failure.set(PushNotificationError.UnsupportedBrowser);
      return false;
    }
    this.working.set(true);
    try {
      if (enabled) {
        const permission =
          Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        this.permissionState.set(permission);
        if (permission !== 'granted') throw PushNotificationError.PermissionDenied;
        this.setDeviceEnabled(true);
      } else {
        this.setDeviceEnabled(false);
      }
      await this.synchronize();
      return true;
    } catch (error) {
      this.checkPermission();
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
    if (!enabled) void this.workerCommand({ type: 'CHAHUA_CLOSE', all: true });
  }

  private checkPermission() {
    this.permissionState.set(Notification.permission);
    if (this.permission() !== 'granted') {
      this.setDeviceEnabled(false);
      void this.synchronize().catch(() => {});
    }
  }

  private synchronize(): Promise<void> {
    // A toggle can change while a background registration is pending. Cleanup runs after it,
    // reads the latest choice, and cannot be undone by that older registration completing.
    this.syncing = this.syncing.catch(() => {}).then(() => (this.enabled() ? this.subscribe() : this.unsubscribe()));
    return this.syncing;
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
      throw PushNotificationError.BackendSubscribeFailed;
    }
  }

  private async unsubscribe(): Promise<void> {
    const subscription = await this.currentSubscription();
    if (!subscription) return;
    try {
      await firstValueFrom(
        this.api.postUnsubscribe(
          { provider: ApiPushProvider.webPush, endpoint: subscription.endpoint },
          { timeout: 10000 },
        ),
      );
    } finally {
      // Stop browser delivery even if the backend is temporarily unreachable.
      await this.push.unsubscribe();
    }
  }
}
