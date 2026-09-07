import { inject, Service, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom, timeout } from 'rxjs';
import { PushService } from '../../generated/endpoints/push/push.service';
import { ApiPushProvider } from '../../generated/models';

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
  private readonly working = signal(false);
  private readonly failure = signal<PushNotificationError | undefined>(undefined);
  readonly permission = this.permissionState.asReadonly();
  readonly subscribed = this.subscriptionState.asReadonly();
  readonly busy = this.working.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly supported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;

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
      this.subscriptionState.set(Notification.permission === 'granted' && status?.hasMatchingEndpoint === true);
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
        await this.subscribe();
      } else {
        await this.unsubscribe();
      }
      this.subscriptionState.set(enabled);
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
    await this.push.unsubscribe();
  }
}
